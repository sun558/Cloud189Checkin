/* eslint-disable no-await-in-loop */
require("dotenv").config();
const log4js = require("log4js");
const recording = require("log4js/lib/appenders/recording");
log4js.configure({
  appenders: {
    vcr: {
      type: "recording",
    },
    out: {
      type: "console",
    },
  },
  categories: { default: { appenders: ["vcr", "out"], level: "info" } },
});

const logger = log4js.getLogger();
// process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'
const superagent = require("superagent");
const { CloudClient } = require("cloud189-sdk");
const serverChan = require("./push/serverChan");
const telegramBot = require("./push/telegramBot");
const wecomBot = require("./push/wecomBot");
const wxpush = require("./push/wxPusher");
const accounts = require("../accounts");

const mask = (s, start, end) => s.split("").fill("*", start, end).join("");

const buildTaskResult = (res, result) => {
  const index = result.length;
  if (res.errorCode === "User_Not_Chance") {
    result.push(`第${index}次抽奖失败,次数不足`);
  } else {
    result.push(`第${index}次抽奖成功,抽奖获得${res.prizeName}`);
  }
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 任务 1.签到 2.天天抽红包 3.自动备份抽红包
const doTask = async (cloudClient) => {
  const result = [];
  const res1 = await cloudClient.userSign();
  result.push(
    '个人'+`${res1.isSign ? "已经签到过了，" : ""}签到获得${res1.netdiskBonus}M空间`
  );
    await delay(5000); // 延迟5秒

//    const res2 = await cloudClient.taskSign();
//    buildTaskResult(res2, result);

//    await delay(5000); // 延迟5秒
//    const res3 = await cloudClient.taskPhoto();
//    buildTaskResult(res3, result);

  return result;
};

const doFamilyTask = async (cloudClient) => {
  const { familyInfoResp } = await cloudClient.getFamilyList();
  const result = [];
  let family_id ;
  if (familyInfoResp) {
     if(!process.env.FAMILY_ID){
		 const  { familyId }  = familyInfoResp[0];
		  family_id  = familyId;
		
         		  
	  }else{
		  family_id  = process.env.FAMILY_ID;
		
	  }
      const res = await cloudClient.familyUserSign(family_id);
	  
	 
      result.push({
		  familySent:
        "家庭" +
          `${res.signStatus ? "已经签到过了，" : ""}签到获得${
            res.bonusSpace
          }M空间`,
		  familySpace: res.bonusSpace
      
	  }
	  )
    }
  
  return result;
};

const pushServerChan = (title, desp) => {
  if (!serverChan.sendKey) {
    return;
  }
  const data = {
    title,
    desp,
  };
  superagent
    .post(`https://sctapi.ftqq.com/${serverChan.sendKey}.send`)
    .type("form")
    .send(data)
    .end((err, res) => {
      if (err) {
        logger.error(`ServerChan推送失败:${JSON.stringify(err)}`);
        return;
      }
      const json = JSON.parse(res.text);
      if (json.code !== 0) {
        logger.error(`ServerChan推送失败:${JSON.stringify(json)}`);
      } else {
        logger.info("ServerChan推送成功");
      }
    });
};

const pushTelegramBot = (title, desp) => {
  if (!(telegramBot.botToken && telegramBot.chatId)) {
    return;
  }
  const data = {
    chat_id: telegramBot.chatId,
    text: `${title}\n\n${desp}`,
  };
  superagent
    .post(`https://api.telegram.org/bot${telegramBot.botToken}/sendMessage`)
    .type("form")
    .send(data)
    .end((err, res) => {
      if (err) {
        logger.error(`TelegramBot推送失败:${JSON.stringify(err)}`);
        return;
      }
      const json = JSON.parse(res.text);
      if (!json.ok) {
        logger.error(`TelegramBot推送失败:${JSON.stringify(json)}`);
      } else {
        logger.info("TelegramBot推送成功");
      }
    });
};

const pushWecomBot = (title, desp) => {
  if (!(wecomBot.key && wecomBot.telphone)) {
    return;
  }
  const data = {
    msgtype: "text",
    text: {
      content: `${title}\n\n${desp}`,
      mentioned_mobile_list: [wecomBot.telphone],
    },
  };
  superagent
    .post(
      `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${wecomBot.key}`
    )
    .send(data)
    .end((err, res) => {
      if (err) {
        logger.error(`wecomBot推送失败:${JSON.stringify(err)}`);
        return;
      }
      const json = JSON.parse(res.text);
      if (json.errcode) {
        logger.error(`wecomBot推送失败:${JSON.stringify(json)}`);
      } else {
        logger.info("wecomBot推送成功");
      }
    });
};

const pushWxPusher = async (title, desp) => {
  try {
    // 参数校验
    if (!wxpush?.appToken || !wxpush?.uid) {
      const errorMsg = 'WxPusher 配置缺失: appToken 或 uid 未设置';
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    // 内容长度校验（避免转为链接）
    if (desp.length > 40000) {
      logger.warn('内容过长，可能被截断');
      desp = desp.substring(0, 40000);
    }

    // 构建请求体
    const data = {
      appToken: wxpush.appToken,
      contentType: 1, // 1=文本，2=HTML
      summary: title.substring(0, 20), // 摘要限制20字符
      content: desp,
      uids: [wxpush.uid],
    };

    // 发送请求
    const res = await superagent
      .post('https://wxpusher.zjiecode.com/api/send/message')
      .set('Content-Type', 'application/json') // 显式设置请求头
      .send(data);

    // 处理响应
    if (res.status !== 200) {
      throw new Error(`HTTP 状态码异常: ${res.status}`);
    }

    const responseData = res.body?.data?.[0];
    if (!responseData || responseData.code !== 1000) {
      const errorMsg = `推送失败: ${responseData?.msg || '未知错误'}`;
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    logger.info('WxPusher 推送成功');
    return true;
  } catch (err) {
    logger.error(`推送异常: ${err.message}`, { error: err.stack });
    throw err; // 向上抛出错误供调用方处理
  }
};

const push = (title, desp) => {
  pushServerChan(title, desp);
  pushTelegramBot(title, desp);
  pushWecomBot(title, desp);
  pushWxPusher(title, desp);
};

// 开始执行程序
async function main() {
  const GB_DIVISOR = 1024 * 1024 * 1024;
  const MASK_RANGE = [3, 7];
  const familySpace = [];
  let sum = 0;

  // 封装容量格式化逻辑
  const formatSize = (bytes) => (bytes / GB_DIVISOR).toFixed(3);

  // 保留原始日志格式的打印函数
  const originalLog = (message) => {
    console.log('');
    logger.log(message);
  };

  for (let index = 0; index < accounts.length; index++) {
    const account = accounts[index];
    const { userName, password } = account;

    if (!userName || !password) continue;

    const userNameInfo = mask(userName, ...MASK_RANGE);
    
    try {
      // 保留原始日志顺序和格式
      if (index === 0) {
        logger.log(`${userNameInfo}开始执行`);
      }
      console.log(`${userNameInfo}开始执行`);

      const cloudClient = new CloudClient(userName, password);
      await cloudClient.login();

      // 保留首次账户的容量记录
      if (index === 0) {
        const { cloudCapacityInfo, familyCapacityInfo } = await cloudClient.getUserSizeInfo();
        logger.log(`前：个人：${formatSize(cloudCapacityInfo.totalSize)}G, 家庭：${
          formatSize(familyCapacityInfo.totalSize)
        }G`);
      }

      // 保持任务执行顺序
      const result = await doTask(cloudClient);
      if (index === 0) {
        result.forEach(r => logger.log(r));
      }

      // 保持家庭任务处理方式
      const familyResult = await doFamilyTask(cloudClient);
      familyResult.forEach(r => {
        if (index === 0) {
          logger.log(r.familySent);
        }
        familySpace.push(r.familySpace);
      });

      // 保留最后一个账户的容量检查
      if (index === accounts.length - 1) {
        const firstAccount = accounts[0];
        if (firstAccount.userName && firstAccount.password) {
          const client = new CloudClient(firstAccount.userName, firstAccount.password);
          await client.login();
          const { cloudCapacityInfo, familyCapacityInfo } = await client.getUserSizeInfo();
          originalLog(`后：个人：${formatSize(cloudCapacityInfo.totalSize)}G, 家庭：${
            formatSize(familyCapacityInfo.totalSize)
          }G`);
        }
      }
    } catch (e) {
      logger.error(e);
      if (e.code === "ETIMEDOUT") throw e;
    }
  }

  // 保持原始统计输出格式
  originalLog(`  `);
  if (familySpace.length > 1) {
    familySpace.forEach(value => sum += value);
    originalLog(`家庭签到: ${sum}M 次数: ${familySpace.length}`);
    originalLog(familySpace.join(' + ') + ' = ' + sum + "M");
  }
  originalLog(`  `);
}


function getLineIndex(str, lineIndex) {
  // 参数校验
  if (typeof str !== 'string' || !Number.isInteger(lineIndex)) {
    return '';
  }

  // 单次分割处理（兼容不同系统换行符）
  const lines = str.split(/\r?\n/);
  
  // 处理边界情况
  return lineIndex >= 0 && lineIndex < lines.length 
    ? String(lines[lineIndex]).trim() // 移除前后空格
    : '';
}

(async () => {
  try {
    await main();
  } catch (error) {
    logger.error('主程序执行失败:', error);
  } finally {
    try {
      const events = recording.replay();
      const content = events
        .map(event => event.data.join(""))
        .join("  \n"); // 使用双空格+换行符分隔

      // 构造推送内容
      const lineCount = content.split('\n').length;
      const firstPart = content.slice(9, 11); // 更安全的字符串截取方式
      const lastThirdLine = getLineIndex(content, lineCount - 3);
      
      // 添加推送容错机制
      await push(
        `${firstPart}${lastThirdLine}`,
        content
      );
    } catch (pushError) {
      logger.error('推送处理失败:', pushError);
    } finally {
      recording.erase();
      logger.info('日志记录已清理');
    }
  }
})();
