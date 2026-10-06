// serve 协议的版本（架构 § 9.11 的方法面）。**它住在这里，且只住在这里。**
//
// **它与产品版本分开**：产品版本每一版都跳（`CHANGELOG` 跟它走），协议版本只在报文形状与语义变时跳。
// 两者绑在一起的话，每一个补丁位都会把按版本 pin 过的客户端甩掉——而版本号正是外部 pin 行为的
// 查询点（`--version --json` 的 `protocol` 那一栏，将来 serve 拒未知版本时 `data.supported` 报的
// 也是这一处）。
export const PROTOCOL_VERSION = '0.1'
