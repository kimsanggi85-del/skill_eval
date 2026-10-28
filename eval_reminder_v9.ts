// 태진다이텍 작업자 숙련도 평가 알림 (ntfy 휴대폰 알림) — v9: Gmail 메일 → ntfy 로 변경
// 규칙: 분기 평가일 N일 전(start_before)부터 매일 발송 → 해당 분기 대상자 전원 '승인완료' 시 자동 중지
//       평가일 경과 후에도 미완료면 매일 발송(지연 D+N 표시)
//       평가 대상 = 입사일(사번 앞 6자리 YYMMDD)이 분기 평가일 이전·당일인 작업자 (앱과 동일 기준)
// 파라미터: ?test=1 (당일 발송 여부 무시·강제 발송) ?dry=1 (발송 없이 결과만) ?date=YYYY-MM-DD (기준일 시뮬레이션)
// 알림 주제: eval_alarm_config.ntfy_topic (앱 설정 화면에서 변경). 한글 제목은 JSON 본문으로 보내야 깨지지 않음
import { createClient } from 'jsr:@supabase/supabase-js@2';

const DEF_TOPIC = 'taejin_qc_call';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const Q_LABEL: Record<string, string> = { Q1: '1분기', Q2: '2분기', Q3: '3분기', Q4: '4분기' };
const JSONH = { 'Content-Type': 'application/json' };
const DAY = 86400000;

type Worker = { id: string; name: string; emp: string; line: string; proc: string };
type Eval = { type: string; workerId: string; year: number; quarter?: string; status: string; score?: number };

function kstToday(): Date {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  return new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()));
}
const ymd = (d: Date) => d.toISOString().slice(0, 10);

// 사번 앞 6자리(YYMMDD) → 입사일 (확인 불가 시 null = 항상 대상)
function hireDate(emp: string, refYear: number): Date | null {
  const m = /^(\d{2})(\d{2})(\d{2})/.exec(String(emp ?? ''));
  if (!m) return null;
  let y = +m[1]; const mo = +m[2], d = +m[3];
  y += (y <= (refYear % 100) + 1) ? 2000 : 1900;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return (dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d) ? dt : null;
}

type Status = {
  q: string; year: number; evalDate: string; dd: number;
  total: number; done: number; pend: Worker[]; notStarted: Worker[]; excluded: Worker[];
};

function quarterStatus(workers: Worker[], evals: Eval[], q: string, year: number, evalDate: Date, today: Date): Status {
  const pend: Worker[] = [], notStarted: Worker[] = [], excluded: Worker[] = [];
  let done = 0, total = 0;
  const refYear = new Date().getUTCFullYear();
  for (const wk of workers) {
    const mine = evals.filter(e => e.type === 'skill' && e.workerId === wk.id && Number(e.year) === year && e.quarter === q);
    const h = hireDate(wk.emp, refYear);
    if (h && h > evalDate && !mine.length) { excluded.push(wk); continue; }   // 평가일 이후 입사 → 대상 아님
    total++;
    if (mine.some(e => e.status === 'approved')) done++;
    else if (mine.some(e => e.status === 'submitted')) pend.push(wk);
    else notStarted.push(wk);
  }
  const dd = Math.round((evalDate.getTime() - today.getTime()) / DAY);
  return { q, year, evalDate: ymd(evalDate), dd, total, done, pend, notStarted, excluded };
}

function ddText(dd: number) { return dd > 0 ? `D-${dd}` : dd === 0 ? '오늘(D-Day)' : `지연 D+${-dd}`; }
function nameList(list: Worker[], max = 15) {
  if (!list.length) return '없음';
  const t = list.slice(0, max).map(w => w.line ? `${w.name}(${w.line})` : w.name).join(', ');
  return list.length > max ? `${t} 외 ${list.length - max}명` : t;
}

// ntfy 알림 제목·본문 (본문은 일반 텍스트, 4,000자 이내)
function buildNote(list: Status[], isTest: boolean) {
  const head = list[0];
  const doneTxt = list.length === 1 ? `${head.done}/${head.total}` : list.map(s => `${s.year} ${Q_LABEL[s.q] ?? s.q} ${s.done}/${s.total}`).join(' · ');
  const title = `${isTest ? '[테스트] ' : ''}[숙련도평가] ${head.year}년 ${Q_LABEL[head.q] ?? head.q} ${ddText(head.dd)} · 승인 ${doneTxt}`;
  const blocks = list.map(s => {
    const pct = s.total ? Math.round(s.done / s.total * 100) : 0;
    const lines = [
      `■ ${s.year}년 ${Q_LABEL[s.q] ?? s.q} · 평가일 ${s.evalDate} (${ddText(s.dd)})`,
      `승인완료 ${s.done}/${s.total}명 (${pct}%)`,
      `미평가 ${s.notStarted.length}명: ${nameList(s.notStarted)}`,
      `승인대기 ${s.pend.length}명: ${nameList(s.pend)}`,
    ];
    if (s.excluded.length) lines.push(`대상외 ${s.excluded.length}명: ${s.excluded.map(w => w.name).join(', ')} (평가일 이후 입사)`);
    if (s.dd < 0) lines.push('평가일이 지났습니다. 조속히 완료해 주세요.');
    return lines.join('\n');
  });
  let message = blocks.join('\n\n') + '\n\n평가자: 강창구 팀장 · 김상기 과장 · 강병주 부장 / 승인대기는 팀장 승인 필요';
  if (message.length > 3800) message = message.slice(0, 3800) + '\n…';
  const urgent = list.some(s => s.dd <= 3);
  return { title, message, priority: urgent ? 4 : 3, tags: [list.some(s => s.dd < 0) ? 'warning' : 'memo'] };
}

async function ntfySend(topic: string, n: { title: string; message: string; priority: number; tags: string[] }, click?: string) {
  const body: Record<string, unknown> = { topic, ...n };
  if (click) body.click = click;
  const r = await fetch('https://ntfy.sh/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`ntfy ${r.status} ${(await r.text()).slice(0, 200)}`);
}

Deno.serve(async (req) => {
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  try {
    const url = new URL(req.url);
    const isTest = url.searchParams.get('test') === '1';
    const isDry = url.searchParams.get('dry') === '1';
    const dateParam = url.searchParams.get('date');
    const today = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? new Date(dateParam + 'T00:00:00Z') : kstToday();

    const { data: cfg, error: cErr } = await sb.from('eval_alarm_config').select('*').eq('id', 1).single();
    if (cErr) throw cErr;
    if (!cfg.enabled && !isTest) return new Response(JSON.stringify({ ok: true, skipped: 'disabled' }), { headers: JSONH });

    // 앱 데이터: 가장 최근에 갱신된 taejin_skill_obs_v* 키 사용 (앱 버전이 올라가도 자동 추종)
    const { data: kv, error: kErr } = await sb.from('kv_store').select('key,value,updated_at')
      .like('key', 'taejin_skill_obs_v%').order('updated_at', { ascending: false }).limit(1);
    if (kErr) throw kErr;
    if (!kv || !kv.length) return new Response(JSON.stringify({ ok: false, error: '평가 데이터(kv_store) 없음' }), { status: 500, headers: JSONH });
    let workers: Worker[] = kv[0].value?.workers ?? [];
    let evals: Eval[] = kv[0].value?.evals ?? [];
    // 시험용: ?extra=이름:사번,이름:사번 (가상 작업자 추가, dry 전용)
    const extra = url.searchParams.get('extra');
    if (extra && isDry) {
      workers = workers.concat(extra.split(',').map((s, i) => { const [n, e] = s.split(':'); return { id: 'X' + i, name: n, emp: e, line: '-', proc: '-' }; }));
    }
    // 시험용: ?allq=Q3 (해당 분기 기존 작업자 전원 승인완료 가정, dry 전용)
    const allq = url.searchParams.get('allq');
    if (allq && isDry) {
      evals = evals.concat((kv[0].value?.workers ?? []).map((w: Worker) => ({ type: 'skill', workerId: w.id, year: today.getUTCFullYear(), quarter: allq, status: 'approved' })));
    }

    const schedule: Record<string, string> = cfg.schedule ?? {};
    const startBefore: number = cfg.start_before ?? 15;
    const trackFrom = new Date((cfg.track_from ?? '2026-01-01') + 'T00:00:00Z');

    // 대상: 알림 시작일(평가일-N) 이 지났고, 아직 대상자 전원 승인완료가 아닌 분기
    const targets: Status[] = [];
    const all: Status[] = [];
    for (const y of [today.getUTCFullYear() - 1, today.getUTCFullYear()]) {
      for (const [q, md] of Object.entries(schedule)) {
        const d = new Date(`${y}-${md}T00:00:00Z`);
        if (d < trackFrom) continue;
        const start = new Date(d.getTime() - startBefore * DAY);
        const st = quarterStatus(workers, evals, q, y, d, today);
        all.push(st);
        if (today >= start && st.done < st.total) targets.push(st);
      }
    }
    // 테스트: 대상이 없으면 가장 가까운 예정 분기로 발송
    let sendList = targets;
    if (isTest && !sendList.length) {
      const next = all.filter(s => s.dd >= 0).sort((a, b) => a.dd - b.dd)[0] ?? all[all.length - 1];
      if (next) sendList = [next];
    }

    const summary = (s: Status) => ({ quarter: `${s.year} ${s.q}`, evalDate: s.evalDate, dday: ddText(s.dd), done: `${s.done}/${s.total}`,
      notStarted: s.notStarted.length, pending: s.pend.length, excluded: s.excluded.map(w => w.name) });

    const topic = String(cfg.ntfy_topic || DEF_TOPIC).trim();
    const todayStr = ymd(today);
    const alreadySent = !isTest && !dateParam && cfg.last_sent_on === todayStr;
    if (!sendList.length || alreadySent || isDry) {
      return new Response(JSON.stringify({
        ok: true, today: todayStr, dataKey: kv[0].key, workers: workers.length,
        willSend: sendList.length > 0 && !alreadySent, alreadySent, dry: isDry,
        targets: sendList.map(summary), topic,
        preview: isDry && sendList.length ? buildNote(sendList, isTest) : undefined,
      }), { headers: JSONH });
    }

    const note = buildNote(sendList, isTest);
    let ok = true, detail = 'sent';
    try { await ntfySend(topic, note, cfg.app_url); }
    catch (e) { ok = false; detail = String(e).slice(0, 500); }
    const recipients = ['ntfy:' + topic];

    for (const s of sendList) {
      await sb.from('eval_alarm_log').insert({
        sent_on: todayStr, quarter: `${s.year}-${s.q}`, eval_date: s.evalDate, dday: s.dd,
        recipients, status: ok ? (isTest ? 'test' : 'sent') : 'error', detail, done_cnt: s.done, total_cnt: s.total,
      });
    }
    if (ok && !isTest && !dateParam) await sb.from('eval_alarm_config').update({ last_sent_on: todayStr }).eq('id', 1);

    return new Response(JSON.stringify({ ok, sent: ok, topic, title: note.title, targets: sendList.map(summary), detail }), { headers: JSONH });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: JSONH });
  }
});
