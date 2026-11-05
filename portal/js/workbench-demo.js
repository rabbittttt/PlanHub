// Portal-owned demo content. These states are examples, never business progress.
export const workbenchDemo = {
  activeStageId: 'planning',
  activeWindowId: 'next',
  stages: [
    { id: 'data', title: '数据准备', description: '核对来源与统计口径' },
    { id: 'forecast', title: '需求预测', description: '复核未来销量变化' },
    { id: 'planning', title: '入库计划', description: '制定各车型月度计划' },
    { id: 'review', title: '协同复核', description: '核对差异与修订结果' }
  ],
  tasks: [
    { id: 'sources', stageId: 'data', title: '确认订单数据来源', description: '数据准备 · 核对最新原表', appId: 'quicklook', action: '查数据', done: true },
    { id: 'demand', stageId: 'forecast', title: '复核车型需求变化', description: '需求预测 · 对照订单与预测', appId: 'forecast', action: '看预测', done: false },
    { id: 'inbound', stageId: 'planning', title: '调整未来各期入库量', description: '入库计划 · 本轮重点工作', appId: 'sop', action: '做计划', done: false },
    { id: 'changes', stageId: 'review', title: '整理差异与修订说明', description: '协同复核 · 汇总待讨论事项', recordId: 'revisions', action: '演示记录', done: false }
  ],
  windows: [
    { id: 'current', name: '本月', description: '执行与回顾', offset: 'M' },
    { id: 'next', name: '下月', description: '重点编制', offset: 'M+1' },
    { id: 'second', name: '下下月', description: '滚动调整', offset: 'M+2' },
    { id: 'later', name: '后续月份', description: '持续研判', offset: 'M+3…' }
  ],
  records: [
    { id: 'scope', title: '计划口径', description: '演示占位：后续展示本轮计划的统计范围、数据版本和口径说明。' },
    { id: 'revisions', title: '修订记录', description: '演示占位：后续展示本轮计划的调整说明与修订记录。' }
  ]
};
