require("dotenv").config();
const fs = require("fs");
const { CloudClient, FileTokenStore } = require("cloud189-sdk");
const recording = require("log4js/lib/appenders/recording");
const accounts = require("../accounts");
let families = [];
try {
  // families.js 不存在或导出为空都不影响：家庭 ID 也可以只在 .env 里配
  families = require("../families") || [];
} catch (e) {
  families = [];
}
const { mask, delay } = require("./utils");
const push = require("./push");
const { log4js, cleanLogs, catLogs } = require("./logger");
const logger = log4js.getLogger();
logger.addContext("user", "");
// 家庭签到默认开启：.env 里不用写 FAMILY_THRESHOLD，不配也照签、照打印
// 想关掉才显式写 FAMILY_THRESHOLD=0
const envFamilyThreshold = process.env.FAMILY_THRESHOLD;
const familyThreshold =
  envFamilyThreshold === undefined || envFamilyThreshold === ""
    ? 1
    : Number.isFinite(Number(envFamilyThreshold))
    ? Number(envFamilyThreshold)
    : 1;
const personalThreshold = process.env.PERSONAL_THRESHOLD || 1;

// 目标家庭 ID：直接在 .env 里写 FAMILY_ID 即可（支持逗号/分号/空格分隔多个）
//   FAMILY_ID=1234567890
//   FAMILY_ID=1234567890,9876543210
// 优先级：.env 的 FAMILY_ID > families.js > 自动挑自建家庭(userRole=1)
const envFamilyIds = String(process.env.FAMILY_ID || "")
  .split(/[,;，、\s]+/)
  .map((item) => item.trim())
  .filter(Boolean);
const targetFamilies =
  envFamilyIds.length > 0 ? envFamilyIds : (families || []).map(String);
const familyIdSource = envFamilyIds.length > 0 ? ".env 的 FAMILY_ID" : "families.js";

const tokenDir = ".token";
let firstUserName; //主账号
let accountIndex = 1; //家庭序号

// 个人任务签到
const doUserTask = async (cloudClient) => {
  const tasks = Array.from({ length: personalThreshold }, () =>
    cloudClient.userSign()
  );
  const result = (await Promise.allSettled(tasks)).filter(
    ({ status, value }) => status === "fulfilled" && !value.isSign
  );
  logger.log(
    `${result.length}/${tasks.length} 个人获得(M): ${
      result.map(({ value }) => value.netdiskBonus)?.join(" ") || "0"
    }`
  );
  await delay(2000); // 延迟2秒
};

/* =========================================================================
 * 家庭签到（重写：AppKey 签名 + Web 域）
 *
 * 为什么原来的失败：
 *   cloudClient.familyUserSign(familyId) 内部打的是
 *     https://api.cloud.189.cn/open/family/manage/exeFamilyUserSign.action
 *   走 AccessToken 签名 → 返回 InvalidSignature: accessTokenSignature is not match
 *   （cloud189-sdk 里这个方法自己就标着 @deprecated 已无效）
 *
 * 正确姿势：
 *   GET https://cloud.189.cn/open/family/manage/exeFamilyUserSign.action
 *   AppKey 签名（appkey=600100422），签名串 = 排序后的 familyId=..&sessionKey=..&Timestamp=..&AppKey=..
 *   即：sessionKey 必须放进 query 一起参与签名（不是只放 URL 不签名，也不是放 header）
 *
 * SDK 的 beforeRequest 钩子已经会替我们做 AppKey 签名：
 *   命中 cloud.189.cn 且路径含 /open → signatureAppKey(options, "600100422")
 * 但它是「先算签名、后补 sessionKey」，所以必须自己先把 sessionKey 塞进 query。
 * ========================================================================= */
const FAMILY_SIGN_URL = "https://cloud.189.cn/open/family/manage/exeFamilyUserSign.action";

const familyUserSign = async (cloudClient, familyId) => {
  const url = new URL(FAMILY_SIGN_URL);

  const send = async () => {
    // 先自己把 sessionKey 塞进 query，保证它进入签名串
    const sessionKey = await cloudClient.getSessionKey();
    url.searchParams.set("familyId", String(familyId));
    url.searchParams.set("sessionKey", sessionKey);

    // throwHttpErrors:false —— 自己解析 errorCode，避免非会话类错误被 got 包装后看不清
    const res = await cloudClient.request.get(url, { throwHttpErrors: false });
    const text = res.body.toString();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error(
        `家庭签到返回非 JSON（HTTP ${res.statusCode}）: ${text.slice(0, 200)}`
      );
    }
    return json;
  };

  let json = await send();

  // 会话过期：清缓存换新会话，重试一次
  if (json.errorCode === "InvalidSessionKey") {
    logger.log("sessionKey 失效，重新获取后重试一次");
    cloudClient.session.sessionKey = "";
    url.searchParams.delete("sessionKey");
    json = await send();
  }

  // 其他 errorCode 必须抛出：吞掉会留下「成功 +0MB」的假记录
  if (json.errorCode) {
    const err = new Error(
      `家庭签到失败 [${json.errorCode}] ${json.errorMsg || ""}`
    );
    err.errorCode = json.errorCode;
    throw err;
  }

  // signStatus: "0"=本次成功；"1"=今天已签（不是错误）
  const signStatus = String(json.signStatus ?? "");
  const signed = signStatus === "0";
  const signedFamilyId = String(json.signFamilyId ?? "");

  return {
    raw: json,
    signed,
    alreadySigned: signStatus === "1",
    // 已签过时 bonusSpace 读到的是旧值，必须置 0
    bonusSpace: signed ? Number(json.bonusSpace) || 0 : 0,
    signedFamilyId,
    // 189 实际记账的家庭不一定是你传的，必须透出
    mismatch: signedFamilyId !== "" && signedFamilyId !== String(familyId),
  };
};

// 家庭任务签到
const doFamilyTask = async (cloudClient) => {
  if (Number(familyThreshold) === 0) {
    logger.log("家庭签到未开启（FAMILY_THRESHOLD=0）");
    return;
  }

  const { familyInfoResp } = await cloudClient.getFamilyList();
  if (!Array.isArray(familyInfoResp) || familyInfoResp.length === 0) {
    logger.log(`未能获取家庭信息（该账号未加入任何家庭）`);
    return;
  }

  // 选定目标家庭：.env 的 FAMILY_ID / families.js → 自建家庭(userRole==1) → 列表第一个
  let familyId = null;
  if (targetFamilies.length > 0) {
    // 按你配置的顺序找，第一个存在的就用它（不是你配的顺序就用列表顺序）
    const targetFamily = targetFamilies
      .map((id) => familyInfoResp.find((familyInfo) => String(familyInfo.familyId) === id))
      .find(Boolean);
    if (targetFamily) {
      familyId = targetFamily.familyId;
    } else {
      logger.log(
        `${familyIdSource} 里配的 ${targetFamilies.join(",")} 不在该账号的家庭列表中，改用默认家庭`
      );
      logger.log(
        `该账号的家庭: ${familyInfoResp
          .map(
            (f) =>
              `${f.familyId}${f.userRole === 1 ? "(自建)" : "(成员)"}${
                f.remarkName ? "/" + f.remarkName : ""
              }`
          )
          .join("  ")}`
      );
    }
  }
  if (!familyId) {
    const ownFamily = familyInfoResp.find((familyInfo) => familyInfo.userRole === 1);
    familyId = (ownFamily || familyInfoResp[0]).familyId;
  }

  // 家庭额度按「账号」记，不按家庭记：重复调用只会拿到 signStatus=1
  const total = Math.max(1, Number(familyThreshold) || 1);
  const tasks = Array.from({ length: total }, () =>
    familyUserSign(cloudClient, familyId)
  );
  const settled = await Promise.allSettled(tasks);

  let gotCount = 0;
  let gotSpace = 0;
  const errors = [];
  settled.forEach((item) => {
    if (item.status !== "fulfilled") {
      const reason = item.reason || {};
      errors.push(reason);
      logger.log(`家庭签到异常: ${reason.errorCode || reason.message || reason}`);
      return;
    }
    const value = item.value;
    if (value.mismatch) {
      logger.log(
        `注意：189 实际记账到家庭 ${value.signedFamilyId}，与目标家庭 ${familyId} 不一致，容量差不可直接相减`
      );
    }
    if (value.signed) {
      gotCount++;
      gotSpace += value.bonusSpace;
    } else if (value.alreadySigned) {
      logger.log(`家庭 ${familyId} 今天已签过，不再重复计入`);
    }
  });

  // 全部失败（比如签名错、接口变更）必须抛出去，否则日志会显示成
  // 「0/1 家庭容量：0M」，和「今天已签」长得一模一样，等于假绿
  if (errors.length === tasks.length) {
    throw errors[0];
  }

  // 汇总行交给 run() 打印：那里才拿得到「家庭总容量」，才能拼成 xM/xxxxG
  return { signedCount: gotCount, total: tasks.length, gotSpace };
};

const run = async (userName, password) => {
  if (userName && password) {
    const before = Date.now();
    const userNameInfo = mask(userName, 3, 7);
    if (accountIndex == 1) {
      firstUserName = userNameInfo;
    }
    try {
      logger.log(`${accountIndex}. 账号 ${userNameInfo}`);
      const cloudClient = new CloudClient({
        username: userName,
        password,
        token: new FileTokenStore(`${tokenDir}/${userName}.json`),
      });
      const beforeUserSizeInfo = await cloudClient.getUserSizeInfo();

      await doUserTask(cloudClient);
      const familyResult = await doFamilyTask(cloudClient);

      const afterUserSizeInfo = await cloudClient.getUserSizeInfo();

      const mb = (bytes) => ((Number(bytes) || 0) / 1024 / 1024).toFixed(0);
      const gb = (bytes) => ((Number(bytes) || 0) / 1024 / 1024 / 1024).toFixed(2);

      const personalBefore = beforeUserSizeInfo.cloudCapacityInfo?.totalSize;
      const personalAfter = afterUserSizeInfo.cloudCapacityInfo?.totalSize;
      const familyBefore = beforeUserSizeInfo.familyCapacityInfo?.totalSize;
      const familyAfter = afterUserSizeInfo.familyCapacityInfo?.totalSize;

      // 家庭行：前面是本次签到「实际拿到的空间」（不是容量差值），后面是家庭总容量
      //   签到成功 → 1/1 家庭容量：61M/16.00G
      //   今天已签 → 0/1 家庭容量：0M/16.00G
      // 家庭签到未开启 / 没有家庭时，退回原来的「容量差」写法
      const familyLog = familyResult
        ? `${familyResult.signedCount}/${familyResult.total} 家庭容量：${familyResult.gotSpace}M/${gb(familyAfter)}G`
        : `家庭容量: ⬆️ ️${mb((familyAfter || 0) - (familyBefore || 0))}M/${gb(familyAfter)}G`;

      logger.log(
        `个人容量:️ ⬆️ ${mb((personalAfter || 0) - (personalBefore || 0))}M/${gb(personalAfter)}G`,
        familyLog
      );
    } catch (e) {
      logger.log(e);
      if (e.code === "ECONNRESET" || e.code === "ETIMEDOUT") {
        logger.log(`${accountIndex}. 账号 ${userNameInfo}请求超时`);
        throw e;
      }
    } finally {
      logger.log(`耗时 ${((Date.now() - before) / 1000).toFixed(2)} 秒`);
      logger.log(" ");
      await delay(Math.random() * 3000 + 1000); // 随机等待1到3秒
    }
  }
};

// 开始执行程序
async function main() {
  if (!fs.existsSync(tokenDir)) {
    fs.mkdirSync(tokenDir);
  }

  const accountsdel = accounts.flatMap((line) => {
    return line
      .split(/\s+/) // 按任意空白符分割
      .filter((item) => item.length > 0); // 防止空字符串
  });

  for (let index = 0; index < accountsdel.length; index += 2) {
    const [userName, password] = accountsdel.slice(index, index + 2);
    await run(userName, password);
    accountIndex++;
  }
  accountIndex--;
}

(async () => {
  try {
    await main();
    //等待日志文件写入
    await delay(1000);
  } finally {
    const logs = catLogs();
    const events = recording.replay();
    const content = events.map((e) => `${e.data.join("")}`).join("  \n");
    const userNameInfo = firstUserName.slice(7, 12);
    push(`${userNameInfo}天翼家庭每日签到`, logs + content);
    recording.erase();
    cleanLogs();
  }
})();
