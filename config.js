/**
 * config.js —— 配置加载模块
 * ------------------------------------------------------------
 * 作用：把 .env 文件里的沙箱密钥读出来，整理成 SDK 需要的格式。
 *
 * 为什么要单独一个文件？
 *   把"读配置"和"业务逻辑"分开，是良好的代码习惯。业务代码只管用，
 *   不用关心密钥到底从哪来。以后换成生产环境，只改这个文件即可。
 *
 * dotenv 是什么？
 *   一个帮你读取 .env 文件、并把里面的 KEY=VALUE 放进 process.env 的工具。
 *   这样代码里用 process.env.AIPAY_APP_ID 就能拿到值。
 */

// 第 1 步：加载 dotenv，它会自动读取项目根目录的 .env 文件
require('dotenv').config();

// 第 2 步：定义一个小工具函数 readEnv —— 读取某个环境变量，如果没配置就报错
// 这样一旦你漏填了某个密钥，程序启动时会立刻明确告诉你，而不是跑到一半才失败
function readEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`缺少必要的环境变量：${name}，请在 .env 文件中填写。`);
  }
  return value.trim();
}

// 第 3 步：把配置整理成一个对象，供其它文件使用
const config = {
  alipay: {
    // 沙箱应用 ID（相当于应用在支付宝的身份证号）
    appId: readEnv('AIPAY_APP_ID'),

    // 应用私钥：Node.js 是非 Java 语言，必须用 PKCS#1 格式那一个
    // 对应 .env 里的 AIPAY_PRIVATE_PKCS_KEY，千万不要用 AIPAY_PRIVATE_KEY（那是 Java 用的）
    privateKey: readEnv('AIPAY_PRIVATE_PKCS_KEY'),

    // 支付宝公钥：用来验证"支付宝返回给我的数据确实是真的支付宝发的"
    alipayPublicKey: readEnv('AIPAY_ALIPAY_PUBLIC_KEY'),

    // 网关地址：默认使用正式线上网关（生产环境）
    // 如需本地沙箱联调，在环境变量显式设置 ALIPAY_GATEWAY=https://openapi-sandbox.dl.alipaydev.com/gateway.do 覆盖
    gateway: process.env.ALIPAY_GATEWAY || 'https://openapi.alipay.com/gateway.do',

    // 商户 ID（seller_id）：必须是 2088 开头的账号
    // 这里用你截图里沙箱"卖家账号"的用户 UID：2088722120303870
    sellerId: '2088722120303870',

    // serviceId：生产服务 ID（来自支付宝服务注册成功后的真实返回值，审核已通过）
    // 沙箱联调时的固定值是 api_mock_service_id，上线已替换为下方真实值
    serviceId: 'API_3127F1D819794292',
  },

  // 我们这个演示服务对外提供的资源地址（接口路径）
  resource: {
    path: '/demo/a2m/resource',   // 访问这个地址就要付费
    goodsName: 'AI 生成内容服务',  // 账单上显示的商品名称
    price: '0.01',                // 每次调用收费 0.01 元（沙箱模拟，不花真钱）
  },

  // 服务监听端口
  port: Number(process.env.PORT) || 3000,
};

// 第 4 步：导出配置对象，其它文件 require('./config') 就能用
module.exports = config;
