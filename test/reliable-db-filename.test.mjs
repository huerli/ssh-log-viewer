import test from 'node:test';
import assert from 'node:assert/strict';
import { reliableDbSlotSize } from '../shared/reliable-db.mjs';
test('recognizes downloaded and uncompressed reliable DB names across platforms', () => {
  for (const name of ['/logs/alarm.gz', 'event', 'C:\\logs\\oob_action.gz', 'ALARM.GZ']) assert.equal(reliableDbSlotSize(name), 128);
  for (const name of ['wholercd.gz', '/logs/wholerecd.gz', 'wholercd']) assert.equal(reliableDbSlotSize(name), 256);
  for (const name of ['signal.log', 'alarm-service.log', 'events.gz', 'alarm.tar.gz']) assert.equal(reliableDbSlotSize(name), undefined);
});
