import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { parseCSV, guessColumns, prepare, compare, motorCSV } = require('../assets/compare.js');

const close = (actual, expected, epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} 与 ${expected} 的差超过 ${epsilon}`);

const series = (time, values) => ({ time, values });
const columns = (over = {}) => ({ time: 'time_s', signal: 'y', trigger: 'trig', timeUnit: 's', ...over });
const event = (over = {}) => ({ edge: 'rising', threshold: 0.5, occurrence: 1, ...over });

test('解析表头与数据行，去掉 BOM 和首尾空白', () => {
  const csv = parseCSV('\uFEFF time_s , y \r\n0, 0\r\n1, 2\r\n');
  assert.deepEqual(csv.headers, ['time_s', 'y']);
  assert.deepEqual(csv.records, [['0', '0'], ['1', '2']]);
});

test('按表头自动识别逗号、分号和制表符分隔', () => {
  assert.deepEqual(parseCSV('a,b\n1,2\n3,4').records, [['1', '2'], ['3', '4']]);
  assert.deepEqual(parseCSV('a;b\n1;2\n3;4').records, [['1', '2'], ['3', '4']]);
  assert.deepEqual(parseCSV('a\tb\n1\t2\n3\t4').records, [['1', '2'], ['3', '4']]);
});

test('支持带引号的字段，包括引号内的分隔符与转义引号', () => {
  const csv = parseCSV('"time,s","say ""hi"""\n1,"a,b"\n2,c\n');
  assert.deepEqual(csv.headers, ['time,s', 'say "hi"']);
  assert.deepEqual(csv.records[0], ['1', 'a,b']);
});

test('跳过开头的空行与结尾的空行', () => {
  assert.deepEqual(parseCSV('\n\n a,b\n1,2\n3,4\n\n\n').records, [['1', '2'], ['3', '4']]);
});

test('拒绝无法安全解析的 CSV', () => {
  assert.throws(() => parseCSV('   '), /为空/);
  assert.throws(() => parseCSV('only\n1'), /至少需要两列/);
  assert.throws(() => parseCSV('a,a\n1,2\n3,4'), /互不重复/);
  assert.throws(() => parseCSV('a,\n1,2\n3,4'), /列名须非空/);
  assert.throws(() => parseCSV('a,b\n1,2'), /至少需要两行数据/);
  assert.throws(() => parseCSV('a,b\n1,2\n3'), /列数与表头不一致/);
  assert.throws(() => parseCSV('a,b\n1,"2\n3,4'), /未闭合的引号/);
  assert.throws(() => parseCSV('a,b\n1,2"3\n4,5'), /引号格式不正确/);
});

test('推断时间、触发和信号列，并识别毫秒单位', () => {
  assert.deepEqual(guessColumns(['time_s', 'start_cmd', 'speed_rpm']), {
    time: 'time_s', signal: 'speed_rpm', trigger: 'start_cmd', timeUnit: 's',
  });
  assert.equal(guessColumns(['Time (ms)', 'speed_rpm']).timeUnit, 'ms');
  assert.equal(guessColumns(['时间', '转速']).timeUnit, 's');
  assert.equal(guessColumns(['t', 'a', 'b']).trigger, '');
});

test('在线性插值处定位触发事件，并从该点重新计时', () => {
  const csv = parseCSV('time_s,trig,y\n0,0,0\n2,1,10\n4,1,20\n');
  const prepared = prepare(csv, columns(), event());
  assert.equal(prepared.triggerTime, 1);
  assert.deepEqual(prepared.time, [-1, 1, 3]);
  assert.deepEqual(prepared.values, [0, 10, 20]);
});

test('支持第 n 次穿越、下降沿和首个采样点对齐', () => {
  const repeats = parseCSV('time_s,trig,y\n0,0,0\n1,1,0\n2,0,0\n3,1,0\n4,1,0\n');
  assert.equal(prepare(repeats, columns(), event()).triggerTime, 0.5);
  assert.equal(prepare(repeats, columns(), event({ occurrence: 2 })).triggerTime, 2.5);

  const falling = parseCSV('time_s,trig,y\n0,1,0\n2,0,0\n');
  assert.equal(prepare(falling, columns(), event({ edge: 'falling' })).triggerTime, 1);

  const first = prepare(repeats, columns({ trigger: '' }), event({ edge: 'first' }));
  assert.equal(first.triggerTime, 0);
});

test('拒绝倒序时间轴、非数值列和缺失的触发事件', () => {
  assert.throws(() => prepare(parseCSV('time_s,trig,y\n0,0,0\n0,1,1\n'), columns(), event()), /严格递增/);
  assert.throws(() => prepare(parseCSV('time_s,trig,y\n0,0,0\n1,1,n\/a\n'), columns(), event()), /包含空值或非数值/);
  assert.throws(() => prepare(parseCSV('time_s,trig,y\n0,0,0\n1,1,1\n'), columns(), event({ occurrence: 3 })), /未找到第 3 次上升穿越阈值/);
  assert.throws(() => prepare(parseCSV('time_s,trig,y\n0,0,0\n1,1,1\n'), columns({ signal: 'missing' }), event()), /请选择有效/);
});

test('只比较重叠时段，并在两条时间轴的并集上插值', () => {
  const result = compare(series([0, 2], [0, 0]), series([1, 3], [10, 10]), 1);
  assert.equal(result.start, 1);
  assert.equal(result.end, 2);
  assert.deepEqual(result.points.map(point => point.t), [1, 2]);
  assert.deepEqual(result.points.map(point => point.delta), [10, 10]);
});

test('偏差严格大于容差才算超差，等于容差视为合格', () => {
  assert.equal(compare(series([0, 1], [0, 0]), series([0, 1], [50, 50]), 50).intervals.length, 0);
  assert.equal(compare(series([0, 1], [0, 0]), series([0, 1], [50.5, 50.5]), 50).intervals.length, 1);
});

test('相邻超差采样合并成一个区间，并保留峰值', () => {
  const result = compare(series([0, 1, 2], [0, 0, 0]), series([0, 1, 2], [60, 80, 60]), 50);
  assert.equal(result.intervals.length, 1);
  assert.deepEqual([result.intervals[0].start, result.intervals[0].end], [0, 2]);
  assert.equal(result.intervals[0].peak.delta, 80);
  assert.equal(result.duration, 2);
  assert.equal(result.peak.delta, 80);
});

test('一段内从正超差跨到负超差时切分成两个方向相反的区间', () => {
  const result = compare(series([0, 1], [0, 0]), series([0, 1], [60, -60]), 50);
  assert.equal(result.intervals.length, 2);
  assert.deepEqual(result.intervals.map(interval => interval.sign), [1, -1]);
  close(result.intervals[0].start, 0);
  close(result.intervals[0].end, 10 / 120);
  close(result.intervals[1].start, 110 / 120);
  close(result.intervals[1].end, 1);
});

test('超差区间的端点落在容差边界上而不是采样点上', () => {
  const result = compare(series([0, 2], [0, 0]), series([0, 2], [30, 90]), 50);
  const [interval] = result.intervals;
  close(interval.start, 2 / 3);
  close(interval.end, 2);
  close(result.duration, 4 / 3);
});

test('拒绝负容差和没有重叠的时段', () => {
  assert.throws(() => compare(series([0, 1], [0, 0]), series([0, 1], [0, 0]), -1), /容差须为大于或等于 0/);
  assert.throws(() => compare(series([0, 1], [0, 0]), series([5, 6], [0, 0]), 0), /没有可比较的重叠时段/);
});

test('100 ms 采样缺口会截断曲线，并排除缺口中的插值超差起点', () => {
  const build = (rows, maximum) => prepare(parseCSV('time_s,y\n' + rows), columns(), event({ edge: 'first' }), maximum);
  const a = build('0,0\n.001,0\n.101,0\n.102,0\n.103,0');
  const b = build('0,0\n.001,0\n.101,100\n.102,100\n.103,100');
  const result = compare(a, b, 10);
  close(result.intervals[0].start, 0.101);
  close(result.comparableDuration, 0.003);
  close(result.duration, 0.002);
  assert.deepEqual(result.gaps.map(gap => gap.source), ['A', 'B']);
  assert.deepEqual(result.points.filter(point => point.breakBefore).map(point => point.t), [0, 0.101]);
  const sparse = compare(build('0,0\n.001,0\n.101,0'), build('0,0\n.001,0\n.101,100'), 10);
  assert.equal(sparse.gaps.length, 2);
  assert.equal(sparse.intervals.length, 0);
  close(sparse.comparableDuration, 0.001);
  close(compare(build('0,0\n.001,0\n.101,0\n.103,0', 0.11),
    build('0,0\n.001,0\n.101,100\n.103,100', 0.11), 10).intervals[0].start, 0.011);
});

test('显式间隔上限能标记全空档，也会拒绝跨缺口的触发沿', () => {
  const csv = parseCSV('time_s,trig,y\n0,0,0\n.1,1,20');
  assert.throws(() => prepare(csv, columns(), event(), 0.015), /触发沿跨采样缺口/);
  const a = prepare(csv, columns(), event({ edge: 'first' }), 0.015);
  const result = compare(a, series([0, 0.1], [5, 5]), 10);
  assert.equal(result.comparableDuration, 0);
  assert.equal(result.peak, null);
  assert.deepEqual(result.intervals, []);
  assert.deepEqual(result.points, []);
});

test('内置样例与 README 公布的演示数字一致', () => {
  const build = side => {
    const csv = parseCSV(motorCSV(side === 'b'));
    return { csv, columns: guessColumns(csv.headers) };
  };
  const baseline = build('a');
  const candidate = build('b');
  assert.deepEqual(baseline.csv.headers, ['time_s', 'start_cmd', 'speed_rpm']);
  assert.equal(baseline.csv.records.length, 204);
  assert.equal(candidate.csv.records.length, 286);

  const a = prepare(baseline.csv, baseline.columns, event());
  const b = prepare(candidate.csv, candidate.columns, event());
  close(a.triggerTime, 1.2125, 1e-6);
  close(b.triggerTime, 1.86, 1e-6);

  const result = compare(a, b, 50);
  assert.equal(result.intervals.length, 1);
  close(result.intervals[0].start, 0.583, 1e-3);
  close(result.intervals[0].end, 1.366, 1e-3);
  close(result.duration, 0.782, 1e-3);
  close(result.peak.delta, 167.0, 0.1);
  assert.equal(result.intervals[0].sign, 1);
});
