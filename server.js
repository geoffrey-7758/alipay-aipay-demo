/**
 * server.js —— 支付宝 AI 按量付费（A2M）演示服务主程序
 * ============================================================
 * 这个程序实现了一个最简单的"按量付费"接口：
 *   用户（或 AI 智能体）来访问 /demo/a2m/resource 这个地址，
 *   没付钱 → 返回 402，告诉他"请先付款"；
 *   付了钱 → 验证付款凭证，确认无误后，返回付费内容。
 *
 * 完整流程三步走（这是支付宝 AI 按量付费的标准协议）：
 *   第 1 步：402 拦截  —— 没付钱，发一张账单（Payment-Needed）
 *   第 2 步：验付      —— 付了钱，核对凭证（payment.verify）
 *   第 3 步：履约确认  —— 核对通过，交付内容并回执（fulfillment.confirm）
 *
 * 建议你按顺序读代码，注释会告诉你每一行在干什么。
 */

// ============ 第 0 部分：引入需要的工具 ============

// express：一个轻量的 Node.js 网页服务器框架，帮我们处理 HTTP 请求
const express = require('express');

// crypto：Node.js 自带的加密工具箱，用来做 RSA 签名（给账单盖章）
const crypto = require('crypto');

// alipay-sdk：支付宝官方 SDK，帮我们调用支付宝的接口、验签
// 注意：这个 SDK 是"默认导出"，所以直接 require，不要写成 { AlipaySdk }
const AlipaySdk = require('alipay-sdk');

// 引入我们前面写好的配置和订单仓库
const config = require('./config');
const orderRepository = require('./orderRepository');

// 创建 express 应用实例
const app = express();
app.use(express.json()); // 让服务器能看懂 JSON 格式的请求体

// ============ 第 1 部分：初始化支付宝 SDK ============

// 用 .env 里读到的沙箱密钥，创建一个支付宝 SDK 客户端
// 之后所有跟支付宝的通信都通过它来完成
const alipaySdk = new AlipaySdk({
  appId: config.alipay.appId,             // 应用 ID
  privateKey: config.alipay.privateKey,   // 应用私钥（PKCS#1 格式）
  alipayPublicKey: config.alipay.alipayPublicKey, // 支付宝公钥（用于验签）
  gateway: config.alipay.gateway,         // 网关地址（沙箱）
  keyType: 'PKCS1',                       // 关键：非 Java 语言私钥是 PKCS#1，必须声明
  timeout: 30000,                         // 超时时间 30 秒
});

// ============ 第 2 部分：几个小工具函数 ============

/**
 * 工具 A：把日期转成"带时区的 ISO 格式"
 * 支付宝要求账单里的付款截止时间长这样：2026-11-18T21:30:00+08:00
 * 注意：不是 new Date().toISOString()（那个是 ...Z 结尾，支付宝不认）
 */
function formatISO8601WithTimezone(date) {
  const pad = (n) => n.toString().padStart(2, '0'); // 数字补零，比如 9 → '09'
  const offset = -date.getTimezoneOffset();        // 当前时区相对 UTC 的分钟偏移
  const sign = offset >= 0 ? '+' : '-';
  const offH = pad(Math.floor(Math.abs(offset) / 60));
  const offM = pad(Math.abs(offset) % 60);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T` +
         `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${offH}:${offM}`;
}

/**
 * 工具 B：Base64URL 编码
 * 支付宝规定账单（Payment-Needed）要用这种编码放进 HTTP 头里。
 * 它和 Base64 类似，只是把 + / = 换成 URL 安全的字符。
 */
function base64UrlEncode(str) {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * 工具 C：Base64URL 解码（编码的逆操作，用来读 Payment-Proof）
 */
function base64UrlDecode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '='; // 补齐 Base64 要求的长度
  return Buffer.from(s, 'base64').toString('utf8');
}

/**
 * 工具 D：生成"商家签名"（seller_signature）
 * ------------------------------------------------------------
 * 账单发给你之前，商家（也就是我们）要先给它盖个章，证明"这张账单是我开的"。
 * 盖章方法：
 *   1. 把账单里几个关键字段按名字的字母顺序排好
 *   2. 拼成 key=value&key=value... 的字符串
 *   3. 用商家的私钥做 RSA-SHA256 签名
 * 特别注意：这里临时把私钥转成密钥对象只是为了签名运算，
 *           绝对不会改写 .env 里的原始私钥！
 */
function generateSellerSignature(params, privateKeyBase64) {
  // 只参与签名的 8 个字段（支付宝协议规定），按 key 字母序排序
  const signKeys = [
    'amount', 'currency', 'goods_name', 'out_trade_no',
    'pay_before', 'resource_id', 'seller_id', 'service_id',
  ].sort();

  // 拼成 "amount=0.01&currency=CNY&..." 这样的字符串
  const signContent = signKeys
    .map((key) => `${key}=${params[key]}`)
    .join('&');

  // 我们的私钥是"裸的 Base64 PKCS#1"，这里临时构造一个密钥对象用于签名
  const keyObject = crypto.createPrivateKey({
    key: Buffer.from(privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs1',
  });

  // 用 RSA-SHA256 算法签名，输出 Base64 字符串
  return crypto.createSign('RSA-SHA256')
    .update(signContent, 'utf8')
    .sign(keyObject, 'base64');
}

/**
 * 工具 E：金额标准化和比较
 * 把 '0.01'、'0.1'、1 这些不同写法统一成 '0.01' 这样两位小数的字符串，方便比较
 */
function normalizeAmount(value) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return `${BigInt(match[1])}.${(match[2] || '').padEnd(2, '0')}`;
}
function amountsEqual(a, b) {
  return normalizeAmount(a) !== null && normalizeAmount(a) === normalizeAmount(b);
}

/**
 * 工具 F：提取支付宝返回的错误信息（兼容两种字段命名）
 * ------------------------------------------------------------
 * 坑：alipay-sdk 返回的业务字段是驼峰 subMsg / subCode，
 * 而支付宝文档中写的是下划线 sub_msg / sub_code。
 * 之前代码只取 sub_msg（下划线），取不到就 fallback 到 msg（往往只是 "Invalid Arguments"），
 * 把真正的错误原因（如 isv.invalid-signature）藏了起来，误导排查。
 * 这个函数两种都兼容，并带上 subCode，确保真实原因能显示出来。
 */
function extractAlipayError(data) {
  if (!data) return '未知错误';
  const subCode = data.subCode || data.sub_code || '';
  const subMsg = data.subMsg || data.sub_msg || '';
  const msg = data.msg || '';
  // 优先显示 subCode + subMsg（最具体的错误），其次 msg
  if (subCode && subMsg) return `${subCode}: ${subMsg}`;
  if (subMsg) return subMsg;
  if (subCode) return subCode;
  return msg || '未知错误';
}

// ============ 第 3 部分：核心接口 ============

/**
 * 这就是我们要付费的那个接口：GET /demo/a2m/resource
 * 逻辑很简单：
 *   - 请求头里没有 Payment-Proof（付款凭证）→ 走"第1步：发账单(402)"
 *   - 请求头里有 Payment-Proof → 走"第2、3步：验付 + 履约"
 */
app.get(config.resource.path, async (req, res) => {
  const paymentProof = req.headers['payment-proof']; // 读取付款凭证请求头
  if (!paymentProof || paymentProof.trim() === '') {
    return createPaymentRequired(res);               // 没付钱 → 发账单
  }
  return verifyAndDeliver(res, paymentProof);        // 付了钱 → 验付交货
});

/**
 * 【第 1 步】createPaymentRequired —— 预下单并返回 402 + amtPaymentLink（新版官方协议）
 * ------------------------------------------------------------
 * 当有人没付钱来访问时，我们：
 *   1. 生成一个订单号
 *   2. 调用支付宝官方预下单接口 alipay.aipay.agent.payment.precreate，
 *      由支付宝生成账单并返回 amt_pre_pay_id（预下单号）
 *   3. 把这笔订单存起来（待支付），供付款后验付时核对
 *   4. 把 amt_pre_pay_id 放进 amtPaymentLink 响应头，返回 HTTP 402
 *
 * 与旧版的区别：旧版是商家自己签名生成 Payment-Needed 账单头；
 * 新版是支付宝服务端生成账单，商家只透传支付宝返回的预下单号。
 */
async function createPaymentRequired(res) {
  try {
    // 生成唯一订单号：订单_时间戳_随机码
    const outTradeNo = `ORDER_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const amount = config.resource.price;      // 金额，比如 '0.01'
    const currency = 'CNY';                    // 币种：人民币
    const resourceId = config.resource.path;   // 购买的资源就是这个接口地址
    const goodsName = config.resource.goodsName;
    const payBefore = formatISO8601WithTimezone(new Date(Date.now() + 30 * 60 * 1000)); // 30分钟内付款有效

    // --- 调用支付宝官方预下单接口，获取 amt_pre_pay_id ---
    // 注意：seller_id 不在 precreate 入参里；商品信息由 service_id + goods_name 等提供
    const precreateResp = await alipaySdk.exec('alipay.aipay.agent.payment.precreate', {
      bizContent: {
        out_trade_no: outTradeNo,   // 商户订单号，用于幂等控制
        amount,                     // 金额（元），不超过 50 元
        currency,                   // CNY
        goods_name: goodsName,      // 商品/服务名称
        service_id: config.alipay.serviceId, // 生产服务 ID
        pay_before: payBefore,      // 支付截止时间（带时区 ISO 格式）
        memo: 'AI 内容生成服务按次收费', // 交易备注，用于账单展示（可选）
      },
    });

    // SDK 返回可能是嵌套结构，也可能是扁平结构，两种都兼容
    const precreateData = precreateResp.alipay_aipay_agent_payment_precreate_response || precreateResp;

    // 只有业务码 10000 且有 amt_pre_pay_id 才算预下单成功
    if (String(precreateData.code) !== '10000' || !precreateData.amt_pre_pay_id) {
      console.error('预下单失败：', extractAlipayError(precreateData));
      return res.status(502).json({
        code: 'PRECREATE_FAILED',
        message: '支付宝预下单失败：' + extractAlipayError(precreateData),
      });
    }
    const amtPrePayId = precreateData.amt_pre_pay_id;
    console.log(`预下单成功：outTradeNo=${outTradeNo}, amtPrePayId=${amtPrePayId}`);

    // 先把这笔订单存起来（状态：待支付）——重要！不然后面验付时找不到订单
    orderRepository.createPending({
      outTradeNo, amount: normalizeAmount(amount), currency, resourceId, goodsName, payBefore,
    });

    // --- 返回 402 + amtPaymentLink 响应头 ---
    // amtPaymentLink 的值就是支付宝返回的 amt_pre_pay_id 原文，不做编码
    res.set('amtPaymentLink', amtPrePayId);
    return res.status(402).json({
      code: 'Payment-Needed', message: '需要支付后才能访问',
      out_trade_no: outTradeNo, amount, currency, goods_name: goodsName,
    });
  } catch (error) {
    console.error('创建账单失败：', error.message);
    return res.status(500).json({ code: 'CREATE_ORDER_ERROR', message: error.message });
  }
}

/**
 * 【第 2、3 步】verifyAndDeliver —— 验付 + 履约 + 交货
 * ------------------------------------------------------------
 * 用户付钱后会带上 Payment-Proof（付款凭证）再来请求一次。我们：
 *   1. 解码凭证，拿到支付宝交易号 trade_no 和凭证 payment_proof
 *   2. 调用支付宝的 payment.verify 接口核对凭证真伪
 *   3. 核对金额、订单号、资源是否都对得上，且不能重复交付
 *   4. 生成内容（履约），再调用 fulfillment.confirm 告诉支付宝"我交付了"
 *   5. 返回 200 和内容，并带上 Payment-Validation 头证明交付有效
 */
async function verifyAndDeliver(res, paymentProof) {
  try {
    // --- 2.1 解码 Payment-Proof ---
    let paymentProofValue, tradeNo, clientSession;
    try {
      const proof = JSON.parse(base64UrlDecode(paymentProof));
      paymentProofValue = proof.protocol && proof.protocol.payment_proof;
      tradeNo = proof.protocol && proof.protocol.trade_no;
      clientSession = proof.method && proof.method.client_session; // 可选字段
    } catch (e) {
      console.error('付款凭证格式错误：', e.message);
      return createPaymentRequired(res); // 凭证坏了，当成没付钱，重新发账单
    }
    if (!paymentProofValue || !tradeNo) return createPaymentRequired(res);

    // --- 2.2 调用支付宝验付接口 ---
    const bizContent = { payment_proof: paymentProofValue, trade_no: tradeNo };
    if (clientSession) bizContent.client_session = clientSession;
    const verifyResp = await alipaySdk.exec('alipay.aipay.agent.payment.verify', { bizContent });

    // SDK 返回可能是嵌套结构，也可能是扁平结构，这里两种都兼容
    const data = verifyResp.alipay_aipay_agent_payment_verify_response || verifyResp;

    // 业务码 10000 才代表成功
    // 说明：alipay-sdk 在配置 alipayPublicKey 后，exec() 内部会自动验证返回签名 sign，
    // 无需也不应在这里重复手工验签（官方要求"用支付宝公钥验签"由 SDK 完成）。
    if (String(data.code) !== '10000') {
      console.error('验付失败：', extractAlipayError(data));
      return createPaymentRequired(res);
    }

    // --- 2.3 严格核对各项信息（防止有人拿假凭证骗内容）---
    const active = data.active;                                    // 凭证是否仍然有效
    const returnedTradeNo = data.trade_no || data.tradeNo || '';   // 支付宝交易号
    const verifyOutTradeNo = data.out_trade_no || data.outTradeNo || ''; // 商户订单号
    const returnedAmount = data.amount;                            // 支付金额
    const returnedResourceId = data.resource_id || data.resourceId || ''; // 资源标识

    // 精确沙箱模式下，验付响应如果没返回金额，允许用本地订单金额兜底
    // （这是支付宝沙箱的特例；生产环境缺金额必须拒绝）
    const exactSandbox = config.alipay.gateway === 'https://openapi-sandbox.dl.alipaydev.com/gateway.do'
      && config.alipay.serviceId === 'api_mock_service_id';
    const order = verifyOutTradeNo ? orderRepository.findByOutTradeNo(verifyOutTradeNo) : null;

    if (active !== true || !verifyOutTradeNo || !order) {
      console.error('验付信息无效或本地订单不存在');
      return createPaymentRequired(res);
    }
    // 交易号必须和传进来的一致
    if (returnedTradeNo && returnedTradeNo !== tradeNo) {
      console.error('交易号不匹配');
      return createPaymentRequired(res);
    }
    // 金额核对：返回的金额要和订单金额一致
    const finalAmount = (returnedAmount === undefined || returnedAmount === null || returnedAmount === '')
      ? (exactSandbox ? order.amount : null) : returnedAmount;
    if (!amountsEqual(order.amount, finalAmount)) {
      console.error('金额不匹配');
      return createPaymentRequired(res);
    }
    // 资源归属核对（新版协议）
    // 官方 verify 文档中 resource_id 字段已标注"已废弃"且为可选，
    // 返回值可能是支付宝自有格式（如 out_res_id_xxx），不再是商户传的资源路径。
    // 因此新版以 out_trade_no（外部幂等号，来自我们自己的订单号）作为资源归属锚点：
    // 订单是通过 verifyOutTradeNo 从本地查出来的，且订单里存的 resourceId 就是本接口，
    // 这一条已经保证了"这笔支付买的就是当前资源"。
    // 若支付宝仍返回 resource_id 且非空，仅记录用于日志，不再作为强校验条件。
    const finalResourceId = returnedResourceId || order.resourceId;
    if (returnedResourceId) {
      console.log(`[验付] 支付宝返回 resource_id=${returnedResourceId}（字段已废弃，仅记录）`);
    }

    // --- 2.4 履约：生成内容（带幂等保护，同一笔订单不会重复生成）---
    const fulfillment = orderRepository.prepareFulfillment({
      outTradeNo: verifyOutTradeNo,
      tradeNo: tradeNo,
      serviceResult: null,
      createResource: () => JSON.stringify({
        status: 'success',
        service_type: 'AI_CONTENT_GENERATION',
        resource_id: config.resource.path,
        content: '恭喜！这是你付费后获得的 AI 生成内容 🎉（演示数据，可替换成真实业务）',
        generated_at: new Date().toISOString(),
      }),
    });

    // --- 2.5 如果已经履约过，直接返回上次结果（幂等）---
    if (fulfillment.state === 'FULFILLED') {
      return sendSuccess(res, tradeNo, verifyOutTradeNo, finalResourceId, fulfillment.serviceResult, true);
    }

    // --- 2.6 调用履约确认接口，告诉支付宝"我把内容交付了"---
    const confirmResp = await alipaySdk.exec('alipay.aipay.agent.fulfillment.confirm', {
      bizContent: { trade_no: tradeNo },
    });
    const confirmData = confirmResp.alipay_aipay_agent_fulfillment_confirm_response || confirmResp;
    if (String(confirmData.code) !== '10000') {
      console.error('履约确认失败：', extractAlipayError(confirmData));
      return res.status(502).json({ code: 'FULFILLMENT_CONFIRM_FAILED', message: '履约确认失败，请用同一凭证重试' });
    }

    // --- 2.7 标记订单最终完成，返回内容给客户端 ---
    orderRepository.markFulfilled(verifyOutTradeNo, tradeNo);
    return sendSuccess(res, tradeNo, verifyOutTradeNo, finalResourceId, fulfillment.serviceResult, false);

  } catch (error) {
    console.error('验付过程异常：', error.message);
    return res.status(500).json({ code: 'VERIFY_FAILED', message: error.message });
  }
}

/**
 * sendSuccess —— 统一的成功响应（第 3 步的最后一步）
 * 除了返回内容，还要带上 Payment-Validation 响应头，
 * 这是支付宝用来验证"这次交付确实有效"的凭证。
 */
function sendSuccess(res, tradeNo, outTradeNo, resourceId, serviceResult, alreadyFulfilled) {
  res.set('Payment-Validation', base64UrlEncode(JSON.stringify({
    trade_no: tradeNo,
    out_trade_no: outTradeNo,
    validated: true,
    resource_id: resourceId,
  })));
  return res.json({
    resource_id: resourceId,
    content: serviceResult,
    trade_no: tradeNo,
    out_trade_no: outTradeNo,
    already_fulfilled: alreadyFulfilled,
    fulfillment_confirmed: true,
  });
}

// ============ 第 4 部分：启动服务 ============

app.listen(config.port, () => {
  console.log('============================================================');
  console.log('  支付宝 AI 按量付费演示服务已启动');
  console.log(`  访问地址：http://localhost:${config.port}${config.resource.path}`);
  console.log('------------------------------------------------------------');
  console.log('  测试方法 1：直接访问 → 会返回 402 账单（表示需要付费）');
  console.log(`  测试方法 2：curl http://localhost:${config.port}${config.resource.path}`);
  console.log('  完整联调：由支付宝沙箱脚本自动完成 402 → 付款 → 验付 → 交货');
  console.log('============================================================');
});
