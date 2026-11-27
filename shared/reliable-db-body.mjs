import { oobActionTypes, operationResults, operationTypes, pointTypes, unlockTypes, wholeRecordDetails, wholeRecordFieldLabels, workConditionBits } from './whole-record-detail.mjs';

// Whole-record offsets follow jdfv2r1c00-loco-mix wholerecord_device.h.
// Values without a documented unit or enum retain their original numeric value.
export function decodeReliableBody(type, bytes, littleEndian = true, portable = false) {
  if (!bytes) return { fields: [], error: '业务体长度异常，无法解析' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fields = [];
  const widths = { u32: 4, i32: 4, u16: 2, i16: 2, u8: 1, i8: 1 };
  const getters = { u32: 'getUint32', i32: 'getInt32', u16: 'getUint16', i16: 'getInt16', u8: 'getUint8', i8: 'getInt8' };
  const add = (section, key, label, offset, kind, length) => {
    const size = kind === 'text' || kind === 'hex' ? length : widths[kind];
    if (offset + size > bytes.length) throw new Error(`${label}超出业务体长度（偏移 ${offset}，需要 ${size} B，实际 ${bytes.length} B）`);
    let value;
    if (kind === 'hex') {
      value = Array.from(bytes.subarray(offset, offset + size), byte => byte.toString(16).padStart(2, '0')).join(' ');
    } else if (kind === 'text') {
      const raw = bytes.subarray(offset, offset + size);
      const end = raw.indexOf(0);
      const text = end < 0 ? raw : raw.subarray(0, end);
      try { value = new TextDecoder('utf-8', { fatal: true }).decode(text); }
      catch { value = new TextDecoder('gb18030').decode(text); }
    } else value = view[getters[kind]](offset, littleEndian);
    fields.push({ section, key, label, offset, size, value });
    return value;
  };
  const read = (section, specs, base = 0) => {
    for (const [key, label, offset, kind, length] of specs) add(section, key, label, base + offset, kind, length);
  };
  try {
    if (type === 0) {
      read('告警', [
        ['start_seq_seq','起始传输序号',0,'u32'], ['start_seq_bd','起始单板序列号',4,'u32'], ['start_seq_time','起始时间',8,'u32'],
        ['dev_no','设备编号',12,'u32'], ['bd_serial_no','单板序列号',16,'u32'], ['time','告警时间',20,'u32'],
        ['km_post','公里标',24,'u32'], ['longi','经度原值',28,'i32'], ['lati','纬度原值',32,'i32'],
        ['bd_type','单板类型',36,'u8'], ['slot_id','槽位号',37,'u8'], ['alm_state','告警状态',38,'u8'],
        ['alm_type','告警类型',39,'u8'], ['para','参数',40,'u32'], ['speed','速度原值',44,'u16'],
        ['res','保留字段',46,'u8'], ['comm_len','说明长度',47,'u8'],
      ]);
      add('告警', 'comment', '告警说明', 48, 'text', bytes[47]);
    } else if (type === 1) {
      read('事件', [
        ['dev_no','设备编号',0,'u32'], ['bd_serial_no','单板序列号',4,'u32'], ['time','事件时间',8,'u32'],
        ['km_post','公里标',12,'u32'], ['longi','经度原值',16,'i32'], ['lati','纬度原值',20,'i32'],
        ['speed','速度原值',24,'u16'], ['bd_type','单板类型',26,'u8'], ['slot_id','槽位号',27,'u8'],
        ['para','参数',28,'u32'], ['reserved','保留字段',32,'u16'], ['reserved_2','保留字节',34,'u8'], ['comm_len','说明长度',35,'u8'],
      ]);
      add('事件', 'comment', '事件说明', 36, 'text', bytes[35]);
    } else if (type === 2) {
      read('全程记录头', [
        ['time','记录时间',0,'u32'], ['seq','记录序号',4,'u32'], ['train_no','车次',8,'text',12],
        ['driver_no','司机号',20,'u32'], ['assistdriver_no','副司机号',24,'u32'], ['station_no','站号',28,'u32'],
        ['station_no_H','站号高位',32,'i8'], ['map_type','地图类型',33,'i8'], ['direction','方向',34,'u8'], ['version','版本',35,'u8'],
      ]);
      if (bytes.length <= 36) return { fields, error: '全程记录内容缺失：记录头之后没有 body 数据' };
      read('全程记录内容', [
        ['event_type','事件类型',0,'u8'], ['shuntting_state','调车状态',1,'u8'], ['tax_state','TAX 状态',2,'u8'], ['dir','运行方向',3,'u8'],
        ['kmpos','公里标',4,'i32'], ['lon','经度原值',8,'i32'], ['lat','纬度原值',12,'i32'], ['speed','速度原值',16,'i16'],
        ['tax_speed_limit','TAX 限速原值',18,'i16'], ['map_speed_limit','地图限速原值',20,'i16'], ['rtk_state','RTK 状态',22,'u8'],
        ['sv_num','卫星数',23,'i8'], ['loc_acc','定位精度原值',24,'i16'], ['bs_id','基站编号',26,'i16'],
        ['rtcm_age','差分龄期原值',28,'i16'], ['ma','MA 原值',30,'i16'], ['track_no','股道号',32,'text',16],
        ['lj_sw','运用／切除位',48,'i8'], ['work_condition','工况',49,'i8'], ['rssi','信号强度原值',50,'i8'], ['cell_mode','蜂窝模式',51,'i8'],
      ], 36);
      for (const field of fields) {
        field.description = wholeRecordFieldLabels[field.key]?.[field.value];
        if (field.key === 'work_condition') {
          field.description = workConditionBits.filter((_, bit) => field.value & (1 << bit)).join('、');
        }
      }
      // Older captures can end after the fixed fields through cell_mode.
      if (bytes.length === 88) return { fields, remaining: bytes.slice(88) };
      const section = '全程记录内容';
      if (portable) {
        add(section, 'portable_train_no', '便携机型车号', 88, 'text', 15);
      } else {
        add(section, 'get_tax_time', 'TAX 箱时间', 88, 'u32');
        if (bytes.subarray(92, 103).some(byte => byte !== 0)) {
          add(section, 'res1', '保留区原始数据', 92, 'hex', 11);
        }
      }
      const detailLength = add(section, 'detail_len', '事件明细长度（B）', 103, 'u8');
      const detailStart = 104;
      const remaining = bytes.slice(detailStart);
      if (detailLength > 72 || detailLength > remaining.length) {
        return { fields, remaining, error: `事件明细长度异常（声明 ${detailLength} B，实际剩余 ${remaining.length} B，上限 72 B）` };
      }
      if (!detailLength) return { fields, remaining };
      const definition = wholeRecordDetails[bytes[36]];
      if (!definition) return { fields, remaining, error: '该事件的明细暂无字段定义，请查看原始数据' };
      const [expectedLength, specs] = definition;
      if (detailLength !== expectedLength) {
        return { fields, remaining, error: `事件类型 ${bytes[36]} 的明细长度异常（预期 ${expectedLength} B，实际 ${detailLength} B）` };
      }
      const detailSection = '事件明细';
      read(detailSection, specs, detailStart);
      const labels = {
        end_reason: { 1: '司机变化', 2: '站场变化', 3: '退出调车', 4: '控制台结束', 5: '异常结束' },
        point_type: pointTypes,
        action_type: bytes[36] === 5 ? oobActionTypes : unlockTypes,
        cab_side: bytes[36] === 21 ? undefined : { 0: '未指定', 1: 'I 端', 2: 'II 端', 111: 'I 端', 112: 'II 端' },
        permission: bytes[36] === 5 ? { 0: '未标记允许越出站界', 1: '允许越出站界' } : undefined,
        operate_type: operationTypes,
        operate_result: operationResults[bytes[detailStart]],
        experiment_type: { 1: '试拉实验', 2: '简略实验' },
        experiment_result: { 0: '失败', 1: '成功' },
      };
      for (const field of fields.filter(field => field.section === detailSection)) {
        const label = labels[field.key]?.[field.value];
        if (label) field.description = label;
        if (field.key === 'slave_car') field.description = field.value === 1 ? '补机' : '主机';
        if (bytes[36] === 21 && field.key === 'cab_side') {
          field.description = ({ 1: 'I 端', 2: 'II 端', 111: 'I 端', 112: 'II 端' })[field.value];
        }
      }
      return { fields, remaining: bytes.slice(detailStart + detailLength) };
    } else return { fields, error: '该业务类型暂无字段定义，请查看原始业务体' };
    const consumed = fields.reduce((end, field) => Math.max(end, field.offset + field.size), 0);
    return { fields, remaining: bytes.slice(consumed) };
  } catch (error) { return { fields, error: error.message }; }
}

export function describeReliableTail(bytes, littleEndian = true) {
  if (!bytes?.length) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const firstValue = bytes.length >= 4 ? view.getUint32(0, littleEndian) : undefined;
  let text;
  let encoding = 'UTF-8';
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { encoding = 'GB18030'; text = new TextDecoder('gb18030').decode(bytes); }
  // Escape binary control characters instead of hiding NULs or losing bytes.
  text = text.replace(/[\x00-\x1f\x7f-\x9f\\]/g, char => char === '\\' ? '\\\\' : `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
  return { firstValue, text, encoding };
}
