// Snapshot of jdfv2r1c00-loco-mix source definitions. Numeric values are preserved.
export const wholeRecordTypes = {
  "1": {
    "name": "WRCDTYPE_RECORD_START",
    "description": ""
  },
  "2": {
    "name": "WRCDTYPE_RECORD_END",
    "description": ""
  },
  "3": {
    "name": "WRCDTYPE_SHUNTING_STATE_CHANGE",
    "description": "列调变化"
  },
  "4": {
    "name": "WRCDTYPE_WORK_CONDITION_CHANGE",
    "description": "工况变化"
  },
  "5": {
    "name": "WRCDTYPE_OOB_ACTION",
    "description": "oob动作"
  },
  "6": {
    "name": "WRCDTYPE_RTK_STATE_CHANGE",
    "description": "rtk状态变化"
  },
  "7": {
    "name": "WRCDTYPE_SPEED_CHANGE",
    "description": "速度变化"
  },
  "8": {
    "name": "WRCDTYPE_4G_SIGNAL_CHANGE",
    "description": "4g信号变化"
  },
  "9": {
    "name": "WRCDTYPE_MA_RECV",
    "description": "ma接收"
  },
  "10": {
    "name": "WRCDTYPE_SIGNAL_CHANGE",
    "description": "信号变化"
  },
  "11": {
    "name": "WRCDTYPE_RAIL_CHANGE",
    "description": "股道变化"
  },
  "12": {
    "name": "WRCDTYPE_LKJ_SWITCH_SET",
    "description": "列调开关设置"
  },
  "13": {
    "name": "WRCDTYPE_TAX_STATUS",
    "description": "TAX箱状态变化"
  },
  "15": {
    "name": "WRCDTYPE_END_ABNORMAL",
    "description": "异常结束事件"
  },
  "16": {
    "name": "WRCDTYPE_UNCERTAIN_RCD_HEAD_UPDATE",
    "description": "原来不确定的事件，刷新司机号车次等信息"
  },
  "17": {
    "name": "WRCDTYPE_DIR_CHANGE",
    "description": ""
  },
  "18": {
    "name": "WRCDTYPE_UNLOCK_CHANGE",
    "description": "解锁操作事件"
  },
  "19": {
    "name": "WRCDTYPE_OVER_LABELING",
    "description": "过标（信号机或站界）事件"
  },
  "20": {
    "name": "WRCDTYPE_LIMIT_SPEED_CHG",
    "description": "记录限速变化事件"
  },
  "21": {
    "name": "WRCDTYPE_UI_OPERATE_RESULT",
    "description": "dsc--add UI界面操作事件"
  },
  "22": {
    "name": "WRCDTYPE_SLAVE_CAR_CHG",
    "description": "dsc--add 本补机改变操作事件"
  },
  "23": {
    "name": "WRCDTYPE_OOB_CHG",
    "description": "dsc--add oob变化事件"
  },
  "24": {
    "name": "WRCDTYPE_STATION_CHG",
    "description": "dsc--add 站场变化事件"
  },
  "25": {
    "name": "WRCDTYPE_TRACK_CHG",
    "description": "dsc--add 股道变化事件"
  },
  "26": {
    "name": "WRCDTYPE_EXPERIMENT",
    "description": "实验上报"
  },
  "27": {
    "name": "WRCDTYPE_MAX",
    "description": ""
  },
  "101": {
    "name": "WRCDTYPE_STOP_BY_S_START",
    "description": "服务端触发事件类型：结束(S端结束C端未结束的旧任务)"
  },
  "102": {
    "name": "WRCDTYPE_STOP_BY_S_LONGTIME",
    "description": "服务端触发事件类型：结束(S端结整长期未结整的任务)"
  },
  "103": {
    "name": "WRCDTYPE_INVALID",
    "description": ""
  }
};
export const alarmTypes = {
  "1": {
    "name": "ALMTYPE_COMM",
    "description": "通信类"
  },
  "2": {
    "name": "ALMTYPE_GNSS",
    "description": "定位类"
  },
  "3": {
    "name": "ALMTYPE_POWER",
    "description": "电源类"
  },
  "4": {
    "name": "ALMTYPE_DEV_ITF",
    "description": "设备接口类"
  },
  "5": {
    "name": "ALMTYPE_VEH_DEV",
    "description": "外部车载设备类"
  },
  "6": {
    "name": "ALMTYPE_SENSOR",
    "description": "传感器类"
  },
  "7": {
    "name": "ALMTYPE_SYSTEM",
    "description": "系统类"
  },
  "8": {
    "name": "ALMTYPE_SERVER",
    "description": "服务器类"
  },
  "9": {
    "name": "ALMTYPE_MAX",
    "description": ""
  }
};
export const transportTypes = {
  "0": {
    "name": "TRSTRANS_ALARM",
    "description": ""
  },
  "1": {
    "name": "TRSTRANS_EVENT",
    "description": ""
  },
  "2": {
    "name": "TRSTRANS_WHOLERCD",
    "description": ""
  },
  "3": {
    "name": "TRSTRANS_OOB_ACTION",
    "description": ""
  },
  "4": {
    "name": "TRSTRANS_MAX",
    "description": ""
  }
};

export function enumDescription(definitions, value) {
  const item = definitions[value];
  return item ? `${value} · ${item.name}${item.description ? `（${item.description}）` : ''}` : `${value} · 未定义`;
}
export function recordTypeDescription(type, body) {
  if (type === 2 && body?.length > 36) return enumDescription(wholeRecordTypes, body[36]);
  if (type === 0 && body?.length > 39) return enumDescription(alarmTypes, body[39]);
  return type === undefined ? '—' : enumDescription(transportTypes, type);
}
