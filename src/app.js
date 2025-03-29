require("dotenv").config();
const fs = require("fs");
const { CloudClient, FileTokenStore } = require("cloud189-sdk");
const recording = require("log4js/lib/appenders/recording");
const accounts = require("../accounts");
const families = require("../families");
const { mask, delay } = require("./utils");
const push = require("./push");
const { log4js, cleanLogs, catLogs } = require("./logger");
const execThreshold = process.env.EXEC_THRESHOLD || 1;
const tokenDir = ".token";
let userSizeInfoLast, userSizeInfoInitial,firstUserName;  //主账号信息

// 个人任务签到
const doUserTask = async (cloudClient, logger, index) => {
	if (index >= 1) return;
  const tasks = Array.from({ length: 1 }, () =>
    cloudClient.userSign()
  );
  const result = (await Promise.allSettled(tasks)).filter(
    ({ status, value }) => status === "fulfilled" && !value.isSign
  );
  logger.info(
    `${result.length}/${tasks.length} 个人获得(M): ${
      result.map(({ value }) => value.netdiskBonus)?.join(" ") || "0"
    }`
  );
  await delay(2000); // 延迟2秒
};

// 家庭任务签到
const doFamilyTask = async (cloudClient, logger, index) => {
	const getRandomConcurrency = (base) => {
		const numericBase = Number(base); // 强制转换为数字类型
		const min = -3;
		const max = 2;
		const randomOffset = Math.floor(Math.random() * (max - min + 1)) + min;
	return Math.max(1, numericBase + randomOffset); 
	}
		const randomTimeout = Math.random() *10000 + 30000; // 超时时间 30~40 秒随机
   try {
    // 获取家庭信息
    const { familyInfoResp } = await cloudClient.getFamilyList();

    if (!familyInfoResp) {
      return logger.error(`未能获取家庭信息`);
    }

    let familyId = null;
	// 指定家庭签到
    if (families.length > 0) {
      const targetFamily = familyInfoResp.find((familyInfo) =>
        families.includes(familyInfo.familyId)
      );
      if (targetFamily) {
        familyId = targetFamily.familyId;
      } else {
        return logger.error(`没有加入到指定家庭分组`);
      }
    } else {
      familyId = familyInfoResp[0].familyId;
    }
	
	// 根据主账号判断并发次数
	const concurrency = index == 0 ? 1 : execThreshold; 
	// 定义任务数组
	const tasks = [];
	const validResults = [];
	for (let i = 0; i < concurrency; i++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), randomTimeout);

      tasks.push(
        (async () => {
          try {
            const res = await Promise.race([
              cloudClient.familyUserSign(familyId, { signal: controller.signal }),
              new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Task timed out')), randomTimeout)
              )
            ]);
            if (res && res.bonusSpace != null && !res.signStatus) {
              validResults.push(res.bonusSpace);
            }
          } catch (error) {
            if (error.name !== 'AbortError') {
              logger.warn(`任务失败: ${error.message}`);
            }
          } finally {
            clearTimeout(timeoutId);
          }
        })()
      );
    }
	// 等待所有任务完成或超时
    await Promise.all(tasks);

    return logger.info(
      `${validResults.length}/${tasks.length} 家庭获得(M): ${
        validResults.join(" ") || "0"
      }`
    );
  } catch (error) {
    logger.error(`任务执行失败: ${error.message}`);
    throw error;
  }
};

const run = async (userName, password, userSizeInfoMap, logger, index) => {
  if (userName && password) {
    const before = Date.now();
	const userNameInfo = mask(userName, 3, 7);
    try {
      logger.log(`${index+1}. 账号 ${userNameInfo}`);
      const cloudClient = new CloudClient({
        username: userName,
        password,
        token: new FileTokenStore(`${tokenDir}/${userName}.json`),
      });
      userSizeInfoMap.set(userName, {
        cloudClient,
        logger,
      });
	  if(index == 0){
			firstUserName = userName;
			userSizeInfoInitial = await cloudClient.getUserSizeInfo();
			userSizeInfoLast = userSizeInfoInitial;
		}
	  
	   await doUserTask(cloudClient, logger, index);
       await doFamilyTask(cloudClient, logger, index);
	   //重新获取主账号的空间信息		  
		 let {cloudClient: firstCloudClient} = userSizeInfoMap.get(firstUserName);
		 let afterUserSizeInfo = await firstCloudClient.getUserSizeInfo();
		
		logger.log(
			`家庭实际：+${(
			(afterUserSizeInfo.familyCapacityInfo.totalSize -
			userSizeInfoLast.familyCapacityInfo.totalSize) /
			1024 /
			1024
			).toFixed(0)}M`);
		userSizeInfoLast = afterUserSizeInfo;	
	   
    } catch (e) {
      if (e.response) {
        logger.log(`请求失败: ${e.response.statusCode}, ${e.response.body}`);
      } else {
        logger.error(e);
      }
      if (e.code === "ECONNRESET" || e.code === "ETIMEDOUT") {
        logger.error("请求超时");
        throw e;
      }
    } finally {
      logger.log(
        `耗时 ${((Date.now() - before) / 1000).toFixed(2)} 秒`
      );
	  logger.log(' ');
	 await delay((Math.random() * 3000) + 3000); // 随机等待3到6秒
    }
  }
};

// 开始执行程序
async function main() {
  if (!fs.existsSync(tokenDir)) {
    fs.mkdirSync(tokenDir);
  }
  //  用于统计实际容量变化
  const userSizeInfoMap = new Map();
  for (let index = 0; index < accounts.length; index++) {
    const account = accounts[index];
    const { userName, password } = account;
    const logger = log4js.getLogger(userName);
    logger.addContext("user", "" );
    await run(userName, password, userSizeInfoMap, logger,index);
  }
 
			
			//主账号详情
  for (const [ userName,{ cloudClient,  logger }] of userSizeInfoMap) {
	  if(userName !== firstUserName) break ;
     const userNameInfo = mask(firstUserName, 3, 7);
			logger.log(`账号 ${userNameInfo}:`);
			logger.log(`前 个人：${ (
				(userSizeInfoInitial.cloudCapacityInfo.totalSize) /
				1024 /
				1024 /
				1024
			).toFixed(3)}G, 家庭：${(
				( userSizeInfoInitial.familyCapacityInfo.totalSize) /
				1024 /
				1024 /
				1024
			).toFixed(3)}G`);
			logger.log(`后 个人：${(
				(userSizeInfoLast.cloudCapacityInfo.totalSize) /
				1024 /
				1024 /
				1024
			).toFixed(3)}G, 家庭：${(
				(userSizeInfoLast.familyCapacityInfo.totalSize) /
				1024 /
				1024 /
				1024
			).toFixed(3)}G`);
			logger.log(
			`个人容量 +${(
			(userSizeInfoLast.cloudCapacityInfo.totalSize -
			userSizeInfoInitial.cloudCapacityInfo.totalSize) /
			1024 /
			1024
			).toFixed(0)}M  家庭容量 +${(
			(userSizeInfoLast.familyCapacityInfo.totalSize -
			userSizeInfoInitial.familyCapacityInfo.totalSize) /
			1024 /
			1024
			).toFixed(0)}M     `
			);
			logger.log(' ');
  }
			
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
	
	const userNameInfo = mask(firstUserName, 3, 7);
	const target = "家庭容量";
	const targetIndex = logs.indexOf(target);
	const startIndex = targetIndex + target.length;
	const contentDel = logs.substring(startIndex, startIndex + 7);
    push(`${userNameInfo.slice(7, 12)}天翼家庭容量${contentDel}`, logs + content);
    recording.erase();
    cleanLogs();
  }
})();
