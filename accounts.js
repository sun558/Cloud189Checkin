module.exports = process.env.TY_ACCOUNTS 
  ? process.env.TY_ACCOUNTS
      .split('\n')          // 按行分割
      .map(line => line.trim()) // 去除每行首尾空格
      .filter(Boolean)      // 移除空行
  : [];

