// Each item points to a registered app's public entry.
export const stages = [
  {
    name: '数据准备', subjects: '共享原表、订单与车型',
    tasks: [
      { title: '核对共享数据原表', appId: 'quicklook' },
      { title: '查看各车型订单趋势', appId: 'orderiq' },
      { title: '核对车型配置资料', appId: 'vehicle-config' }
    ]
  },
  {
    name: '需求预测', subjects: '销量预测与需求变化',
    tasks: [
      { title: '复核车型销量预测', appId: 'forecast' },
      { title: '对照近期订单变化', appId: 'orderiq' },
      { title: '查看声量与客户线索', appId: 'leads' }
    ]
  },
  {
    name: '入库计划', subjects: '月度入库量与销量预测',
    tasks: [
      { title: '编制各车型月度入库计划', appId: 'sop' },
      { title: '对照各期销量预测', appId: 'forecast' }
    ]
  },
  {
    name: '协同复核', subjects: '计划版本与来源资料',
    tasks: [
      { title: '复核计划版本与资料差异', appId: 'sop' },
      { title: '查阅共享原表', appId: 'quicklook' }
    ]
  }
];
