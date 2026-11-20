/**
 * orderRepository.js —— 订单仓库（负责"记账"）
 * ------------------------------------------------------------
 * 作用：把每一笔订单的状态存在本地文件 orders.json 里，保证：
 *   1. 订单不丢失（重启服务后还能找到）
 *   2. 不能重复履约（同一笔钱只能换一次内容，防止"一钱多单"）
 *
 * 这个文件就是支付宝示例里要求绑定的 orderRepository。
 * 真实生产项目应换成数据库（MySQL/PostgreSQL）+ 事务 + 唯一索引；
 * 这里用 JSON 文件是为了让你能看懂、能跑起来。
 */

const fs = require('fs');
const path = require('path');

// 订单数据存在项目根目录的 orders.json 文件里
const DATA_FILE = path.join(__dirname, 'orders.json');

// 如果文件不存在，先创建一个空的 {}（后面以订单号作为 key 存每笔订单）
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, '{}', 'utf8');
}

// 从文件读取全部订单（每次操作都重新读，保证拿到最新状态）
function readAll() {
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  return JSON.parse(raw || '{}');
}

// 把全部订单写回文件
function writeAll(orders) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(orders, null, 2), 'utf8');
}

/**
 * 订单仓库对象，提供 4 个方法（这 4 个名字是支付宝协议固定要求的）
 */
const repository = {
  /**
   * 方法 1：createPending —— 创建"待支付"订单
   * 当用户第一次访问付费接口（还没付钱）时调用
   */
  createPending(order) {
    const orders = readAll();
    orders[order.outTradeNo] = {
      ...order,                 // 保留传入的所有字段
      orderStatus: 'PENDING_PAYMENT', // 订单状态：等待支付
      fulfillStatus: 'UNFULFILLED',   // 履约状态：还没交付内容
      createdAt: new Date().toISOString(),
    };
    writeAll(orders);
    console.log(`[订单] 已创建待支付订单：${order.outTradeNo}`);
  },

  /**
   * 方法 2：findByOutTradeNo —— 用商户订单号查订单
   * 验付成功后，支付宝会告诉我们这是哪笔订单，用这个方法找回来
   */
  findByOutTradeNo(outTradeNo) {
    const orders = readAll();
    return orders[outTradeNo] || null;
  },

  /**
   * 方法 3：prepareFulfillment —— 准备履约（关键！防重复交付）
   * 这里是整个演示最重要的"幂等"逻辑：
   *   如果这个订单已经交付过了，就直接返回上次的结果，绝不重复生成内容
   *   如果是第一次，就生成内容并标记为"待确认/已交付"
   * @param {Object} params 包含 outTradeNo、tradeNo、期望金额、期望资源、createResource 回调
   */
  prepareFulfillment(params) {
    const orders = readAll();
    const order = orders[params.outTradeNo];

    // 安全检查：订单必须存在
    if (!order) {
      throw new Error(`订单不存在：${params.outTradeNo}`);
    }

    // 幂等检查：如果已经交付过了，直接把上次的结果返回（这就是"一钱一单"的保证）
    if (order.fulfillStatus === 'FULFILLED' || order.fulfillStatus === 'PENDING_CONFIRM') {
      console.log(`[订单] 检测到重复请求，直接返回已有结果：${params.outTradeNo}`);
      return {
        state: order.fulfillStatus,
        serviceResult: order.serviceResult,
      };
    }

    // 生成服务内容（调用传入的回调函数，回调里是我们真正的"业务产出"）
    const serviceResult = params.createResource();

    // 标记为"待确认"，并把结果和交易号存起来
    order.tradeNo = params.tradeNo;
    order.serviceResult = serviceResult;
    order.fulfillStatus = 'PENDING_CONFIRM';
    order.orderStatus = 'PAID';
    orders[params.outTradeNo] = order;
    writeAll(orders);

    console.log(`[订单] 已生成内容并标记待确认：${params.outTradeNo}`);
    return { state: 'PENDING_CONFIRM', serviceResult };
  },

  /**
   * 方法 4：markFulfilled —— 标记"履约完成"
   * 当支付宝确认我们已经交付成功后，把订单状态改成最终完成
   */
  markFulfilled(outTradeNo, tradeNo) {
    const orders = readAll();
    const order = orders[outTradeNo];
    if (order) {
      order.fulfillStatus = 'FULFILLED';
      order.tradeNo = tradeNo;
      order.fulfilledAt = new Date().toISOString();
      orders[outTradeNo] = order;
      writeAll(orders);
      console.log(`[订单] 履约完成：${outTradeNo}`);
    }
  },
};

module.exports = repository;
