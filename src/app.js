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
const execThreshold = process.env.EXEC_THRESHOLD || 1;
const tokenDir = ".token";
let firstUserName;  //主账号
const isMainAccount = true;
const originalLog = (message) => {
    console.log('');
    logger.log(message);
  };
  let accountIndex = 1;  //家庭序号



// 个人任务签到
const doUserTask = async (cloudClient) => {
	if (!isMainAccount || accountIndex > 1)  return;

  const tasks = Array.from({ length: 1 }, () =>
    cloudClient.userSign()
  );
  const result = (await Promise.allSettled(tasks)).filter(
    ({ status, value }) => status === "fulfilled" && !value.isSign
  );
   console.log(
    `${result.length}/${tasks.length} 个人获得(M): ${
      result.map(({ value }) => value.netdiskBonus)?.join(" ") || "0"
    }`
  );
  await delay(2000); // 延迟2秒
};

// 家庭任务签到
const doFamilyTask = async (cloudClient, acquireFamilyTotalSize,errorMessages,userNameInfo) => {
  const { familyInfoResp } = await cloudClient.getFamilyList();
  if (!familyInfoResp) {
	  console.log(`未能获取家庭信息`);
      return errorMessages.push(`${accountIndex}. 账号 ${userNameInfo} 错误: 未能获取家庭信息`);
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
		  console.log(`没有加入到指定家庭分组`);
        return errorMessages.push(`${accountIndex}. 账号 ${userNameInfo} 错误: 没有加入指定家庭组`);
      }
    } else {
      familyId = familyInfoResp[0].familyId;
    }
	
   
    const tasks = Array.from({ length: accountIndex == 1? 1: execThreshold }, () =>
      cloudClient.familyUserSign(familyId)
    );
    const result = (await Promise.allSettled(tasks)).filter(
      ({ status, value }) => status === "fulfilled" && !value.signStatus
    );
	result.forEach(({ value }) => {
		if (value.bonusSpace !== undefined && value.bonusSpace !== null) {
			acquireFamilyTotalSize.push(value.bonusSpace);
		}
	});
	return console.log(
      `${result.length}/${tasks.length} 家庭获得(M): ${
       result.map(({ value }) => value.bonusSpace)?.join(",") || "0"
      }`
    );
	
};

const run = async (userName, password, userSizeInfoMap, acquireFamilyTotalSize,errorMessages) => {
  if (userName && password) {
    const before = Date.now();
	const userNameInfo = mask(userName, 3, 7);
    try {
       console.log(`${accountIndex}. 账号 ${userNameInfo}`);
      const cloudClient =  new CloudClient({
        username: userName,
        password,
        token: new FileTokenStore(`${tokenDir}/${userName}.json`),
      });
     const beforeUserSizeInfo = await cloudClient.getUserSizeInfo();
      userSizeInfoMap.set(userName, {
        cloudClient,
        userSizeInfo: beforeUserSizeInfo
      });
	   if(isMainAccount && accountIndex == 1){
			firstUserName = userName;
		}
      
       await doUserTask(cloudClient);
       await doFamilyTask(cloudClient,acquireFamilyTotalSize,errorMessages,userNameInfo);
		
		
      
    } catch (e) {
      console.log(e);
      if (e.code === "ECONNRESET" || e.code === "ETIMEDOUT") {
        logger.error(`${accountIndex}. 账号 ${userNameInfo}请求超时`);
        throw e;
      }else{
		
		errorMessages.push( `${accountIndex}. 账号 ${userNameInfo} 错误: ${
    typeof e === "string" ? e : e.message || "未知错误"
  }`);
      
	  }
	  
    } finally {
     console.log(
        `耗时 ${((Date.now() - before) / 1000).toFixed(2)} 秒`
      );
	  console.log(' ');
	 await delay((Math.random() * 3000) + 1000); // 随机等待1到3秒
    }
  }
};

// 开始执行程序
async function main() {
	const acquireFamilyTotalSize = [];  //获得家庭总量 
	const errorMessages = [];
	
	
  if (!fs.existsSync(tokenDir)) {
    fs.mkdirSync(tokenDir);
  }
  //  用于统计实际容量变化
  const userSizeInfoMap = new Map();
  
	const accountsdel = accounts.flatMap(line => {
		return line
			.split(/\s+/) // 按任意空白符分割
			.filter(item => item.length > 0) // 防止空字符串
});
  for (let index = 0; index < accountsdel.length; index += 2) {
    const [ userName, password ] = accountsdel.slice(index, index + 2);
    await run(userName, password, userSizeInfoMap, acquireFamilyTotalSize,errorMessages);
	accountIndex++;
  }
  accountIndex--;
 
  //主账号详情
  for (const [userName,{ cloudClient,userSizeInfo }] of userSizeInfoMap) {
	   if(isMainAccount){
		   const userNameInfo = mask(userName, 3, 7);
			const afterUserSizeInfo = await cloudClient.getUserSizeInfo();
			logger.log(`账号 ${userNameInfo}:`);
			logger.log(`前 个人：${ (
				(userSizeInfo.cloudCapacityInfo.totalSize) /
				1024 /
				1024 /
				1024
			).toFixed(3)}G, 家庭：${(
				( userSizeInfo.familyCapacityInfo.totalSize) /
				1024 /
				1024 /
				1024
			).toFixed(3)}G`);
			logger.log(`后 个人：${(
				(afterUserSizeInfo.cloudCapacityInfo.totalSize) /
				1024 /
				1024 /
				1024
			).toFixed(3)}G, 家庭：${(
				(afterUserSizeInfo.familyCapacityInfo.totalSize) /
				1024 /
				1024 /
				1024
			).toFixed(3)}G`);
			logger.log(
			`个人 +${(
			(afterUserSizeInfo.cloudCapacityInfo.totalSize -
			userSizeInfo.cloudCapacityInfo.totalSize) /
			1024 /
			1024
			).toFixed(0)}M  家庭 +${(
			(afterUserSizeInfo.familyCapacityInfo.totalSize -
			userSizeInfo.familyCapacityInfo.totalSize) /
			1024 /
			1024
			).toFixed(0)}M  签到 ${acquireFamilyTotalSize.length}/${accountIndex} 次`
			);
			logger.log(' ');
			break;
	 }else{
		 const sumFamilyTotalSize = acquireFamilyTotalSize.reduce((accumulator, currentValue) => {
				return accumulator + currentValue;
			}, 0);
		 logger.log(
		`家庭容量 +${
		sumFamilyTotalSize}M  签到 ${acquireFamilyTotalSize.length}/${accountIndex}次   `
		);
		 logger.log(
		`家庭获得 ${
		acquireFamilyTotalSize?.length > 0? acquireFamilyTotalSize.join(" + "): "0"} = ${sumFamilyTotalSize}M     `
		);
		logger.log(' ');
		break;
	 }
  }
  
  // 错误信息输出
  if (errorMessages.length > 0) {
    originalLog(' ');
    originalLog('错误信息:');
    errorMessages.forEach(msg => originalLog(msg));
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

	const userNameInfo = isMainAccount? mask(firstUserName, 3, 7).slice(9, 12):" ";
	const target = ["家庭容量"].includes(logs) ? "家庭容量": "M  家庭";
	const targetIndex = logs.indexOf(target);
	const startIndex = targetIndex + target.length;
	const contentDel = logs.substring(startIndex, startIndex + 15);
    push(`${userNameInfo}家庭${contentDel}`, logs + content);
    recording.erase();
    cleanLogs();
  }
})();
