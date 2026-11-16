# 订单销售报表只读示例

`order-sales-current.mjs` 从已有本机原型的只读接口获取订单商品明细1752、平台视图839，再向**已由网页授权绑定**的会话发布计划、真实读取步骤、部分指标、页面区块、核验表和预览完成事件。

共享版连接器已启动且网页已绑定目标会话后，在连接器仓库根目录运行。

```sh
node examples/order-sales-current.mjs --session <ses...>
```

- 不创建表格、不写订单、不保存平台草稿、不发布页面，不调用大模型。
- 真实读取使用既有4173受控接口和其原有CLI Profile/数据白名单，不改现有CLI或后端。
- 平台视图范围与明细样本分开；视图底部每日统计汇总不宣称是全企业全量。接口total矛盾时不拿它作分母，不编造利润、客单价或退款率。
- 同目录 `order-sales-current-events.json` 是生成时刻的数据快照。重放只表示载入历史预览，不代表重新读取当前数据；刷新数据应重新运行脚本。
- `--runtime <0600状态文件>` 和 `--wait-ui-ack` 用于隔离手工验收，普通使用无需传。后者等待真实浏览器已看见部分页面的确认，不是产品延时动画。
- 手工当前会话验收驱动位于 `../../lingtong-prototypes/kmMDTable/agent/current-session-check.mjs`，仅在17654隔离端口运行，明确传入所观察会话ID，不会发送prompt或改原权限，不应当作生产启动程序。

本次验收截图与完整边界见[共享会话记录](../../lingtong-prototypes/kmMDTable/agent/shared-session-notes.md)。
