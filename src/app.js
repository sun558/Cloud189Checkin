require("dotenv").config();
const fs = require("fs");
const { CloudClient, FileTokenStore } = require("cloud189-sdk");
const recording = require("log4js/lib/appenders/recording");
const accounts = require("../accounts");
const families = require("../families");
const { mask, delay } = require("./utils");
const push = require("./push");
const { log4js, cleanLogs, catLogs } = require("./logger");
 const logger = log4js.getLogger();
    logger.addContext("user", "" );
const familyThreshold = process.env.FAMILY_THRESHOLD || 0;
const personalThreshold = process.env.PERSONAL_THRESHOLD || 1;
const tokenDir = ".token";
let firstUserName;  //主账号
  let accountIndex = 1;  //家庭序号



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

// 家庭任务签到
const doFamilyTask = async (cloudClient) => {
	if(familyThreshold == 0) return;
  const { familyInfoResp } = await cloudClient.getFamilyList();
  if (!familyInfoResp) {
	  logger.log(`未能获取家庭信息`);
    }
  
    let familyId = null;
    //指定家庭签到
    if (families.length > 0) {
      const targetFamily = familyInfoResp.find((familyInfo) =>
        families.includes(familyInfo.familyId)
      );
      if (targetFamily) {
        familyId = targetFamily.familyId;
      } else {
		  logger.log(`没有加入到指定家庭分组`);
        
      }
    } else {
      familyId = familyInfoResp[0].familyId;
    }
	
   
    const tasks = Array.from({ length: familyThreshold }, () =>
      cloudClient.familyUserSign(familyId)
    );
    const result = (await Promise.allSettled(tasks)).filter(
      ({ status, value }) => status === "fulfilled" && !value.signStatus
    );
	
	return logger.log(
      `${result.length}/${tasks.length} 家庭获得(M): ${
       result.map(({ value }) => value.bonusSpace)?.join(",") || "0"
      }`
    );
	
};

const run = async (userName, password) => {
  if (userName && password) {
    const before = Date.now();
	const userNameInfo = mask(userName, 3, 7);
	 if(accountIndex == 1){
			firstUserName = userNameInfo;
		}
    try {
       logger.log(`${accountIndex}. 账号 ${userNameInfo}`);
      const cloudClient =  new CloudClient({
        username: userName,
        password,
        token: new FileTokenStore(`${tokenDir}/${userName}.json`),
      });
     const beforeUserSizeInfo = await cloudClient.getUserSizeInfo();
      
      
       await doUserTask(cloudClient);
       await doFamilyTask(cloudClient);		
	   
	   
	    const afterUserSizeInfo = await cloudClient.getUserSizeInfo();
		 logger.log(  
      `个人容量:️ ⬆️ ${(
        (afterUserSizeInfo.cloudCapacityInfo.totalSize -
           beforeUserSizeInfo.cloudCapacityInfo.totalSize) /
        1024 /
        1024
      ).toFixed(0)}M/${(
        afterUserSizeInfo.cloudCapacityInfo.totalSize /
        1024 /
        1024 /
        1024
      ).toFixed(2)}G`,
      `家庭容量: ⬆️ ️${(
        (afterUserSizeInfo.familyCapacityInfo.totalSize -
           beforeUserSizeInfo.familyCapacityInfo.totalSize) /
        1024 /
        1024
      ).toFixed(0)}M/${(
        afterUserSizeInfo.familyCapacityInfo.totalSize /
        1024 /
        1024 /
        1024
      ).toFixed(2)}G`
    );
	
		
      
    } catch (e) {
      logger.log(e);
      if (e.code === "ECONNRESET" || e.code === "ETIMEDOUT") {
        logger.log(`${accountIndex}. 账号 ${userNameInfo}请求超时`);
        throw e;
      }
	  
    } finally {
     logger.log(
        `耗时 ${((Date.now() - before) / 1000).toFixed(2)} 秒`
      );
	  logger.log(' ');
	 await delay((Math.random() * 3000) + 1000); // 随机等待1到3秒
    }
  }
};

// 开始执行程序
async function main() {
	
  if (!fs.existsSync(tokenDir)) {
    fs.mkdirSync(tokenDir);
  }
  
  
	const accountsdel = accounts.flatMap(line => {
		return line
			.split(/\s+/) // 按任意空白符分割
			.filter(item => item.length > 0) // 防止空字符串
});

  for (let index = 0; index < accountsdel.length; index += 2) {
    const [ userName, password ] = accountsdel.slice(index, index + 2);
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
