// scripts/test-activities-paging.mjs
// node 端验证 fetchClassActivities 的自动翻页与去重
// 用 stub fetch 模拟 logs API 的分页响应
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('  ✅', name); } else { fail++; console.log('  ❌', name); } };

globalThis.window = globalThis;
globalThis.location = { pathname: '/v2/web/index' };

const PAGE_SIZE = 50;
/** 造一个 classroom activity */
const mkAct = (i) => ({ id: 1000 + i, type: 14, courseware_id: 5000 + i, title: `课堂${i}` });

/** 构造 n 条数据，按 PAGE_SIZE 分页 */
function makeServer(total, { dupAt = null } = {}) {
  const all = Array.from({ length: total }, (_, i) => mkAct(i));
  if (dupAt != null) all.splice(dupAt, 0, all[0]); // 插入一条重复项
  return async (url) => {
    const page = Number(new URL(url, 'https://x').searchParams.get('page') || 0);
    const offset = Number(new URL(url, 'https://x').searchParams.get('offset') || PAGE_SIZE);
    const slice = all.slice(page * offset, page * offset + offset);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { activities: slice } }),
    };
  };
}

globalThis.fetch = makeServer(0);   // 先占位，各用例覆盖

const { fetchClassActivities } = await import('../src/core/history-capture.js');

console.log('== 单页（少于 50 条） ==');
{
  globalThis.fetch = makeServer(12);
  const r = await fetchClassActivities('123');
  ok(r.length === 12, `取到 12 条（实际 ${r.length}）`);
}

console.log('== 恰好一页（50 条） ==');
{
  let calls = 0;
  const base = makeServer(50);
  globalThis.fetch = async (u) => { calls++; return base(u); };
  const r = await fetchClassActivities('123');
  ok(r.length === 50, `取到 50 条（实际 ${r.length}）`);
  // 满页时必须再探一次才能确认后面没有数据（服务端不返回总数），
  // 这是必要的边界探测，不是多余请求
  ok(calls === 2, `请求 2 次（满页需探一页确认结束，实际 ${calls}）`);
}

console.log('== 跨页（120 条 → 需要 3 次请求） ==');
{
  let calls = 0;
  const base = makeServer(120);
  globalThis.fetch = async (u) => { calls++; return base(u); };
  const r = await fetchClassActivities('123');
  ok(r.length === 120, `取到 120 条（实际 ${r.length}）`);
  ok(calls === 3, `请求 3 次（实际 ${calls}）`);
  // 验证顺序保持
  ok(r[0].title === '课堂0' && r[119].title === '课堂119', '顺序与顺序一致');
}

console.log('== 去重（服务端重复返回同一条） ==');
{
  globalThis.fetch = makeServer(10, { dupAt: 5 });
  const r = await fetchClassActivities('123');
  ok(r.length === 10, `去重后 10 条（实际 ${r.length}）`);
  const ids = new Set(r.map(a => `${a.id}:${a.courseware_id}`));
  ok(ids.size === r.length, '无重复条目');
}

console.log('== 过滤非课堂类型（非 type=14 应剔除） ==');
{
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ data: { activities: [
      { id: 1, type: 14, courseware_id: 1, title: '课堂' },
      { id: 2, type: 99, courseware_id: 2, title: '非课堂' },
      { id: 3, type: 14, courseware_id: null, title: '无课件' },
    ] } }),
  });
  const r = await fetchClassActivities('123');
  ok(r.length === 1 && r[0].title === '课堂', `只剩 1 条有效课堂（实际 ${r.length}）`);
}

console.log('== 空列表（不进入死循环） ==');
{
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true, status: 200, json: async () => ({ data: { activities: [] } }) }; };
  const r = await fetchClassActivities('123');
  ok(r.length === 0, '返回空数组');
  ok(calls === 1, `只请求 1 次即停止（实际 ${calls}）`);
}

console.log('== HTTP 错误应抛错（不静默返回空） ==');
{
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  let threw = false;
  try { await fetchClassActivities('123'); } catch { threw = true; }
  ok(threw, 'HTTP 500 抛错');
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
