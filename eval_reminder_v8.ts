// 태진다이텍 작업자 숙련도 평가 메일 알람 (Gmail SMTP)
// 규칙: 분기 평가일 N일 전(start_before)부터 매일 발송 → 해당 분기 대상자 전원 '승인완료' 시 자동 중지
//       평가일 경과 후에도 미완료면 매일 발송(지연 D+N 표시)
//       평가 대상 = 입사일(사번 앞 6자리 YYMMDD)이 분기 평가일 이전·당일인 작업자 (앱과 동일 기준)
// 파라미터: ?test=1 (당일 발송 여부 무시·강제 발송) ?dry=1 (발송 없이 결과만) ?date=YYYY-MM-DD (기준일 시뮬레이션)
// 주의: 메일 제목은 ASCII 유지 (한글 제목 인코딩 시 헤더 깨짐)
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts';

const GMAIL_USER = (Deno.env.get('GMAIL_USER') ?? '').trim();
const GMAIL_PASS = (Deno.env.get('GMAIL_APP_PASSWORD') ?? '').replace(/\s+/g, '');
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
const esc = (s: string) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

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
function ddAscii(dd: number) { return dd > 0 ? `D-${dd}` : dd === 0 ? 'D-DAY' : `OVERDUE D+${-dd}`; }

function names(list: Worker[]) {
  if (!list.length) return '<span style="color:#94a3b8">없음</span>';
  return list.map(w => `<span style="display:inline-block;background:#f1f5f9;border-radius:6px;padding:2px 8px;margin:2px 4px 2px 0;font-size:12.5px">${esc(w.name)} <span style="color:#64748b">${esc(w.line)}</span></span>`).join('');
}

function buildHtml(list: Status[], appUrl: string, isTest: boolean) {
  const blocks = list.map(s => {
    const pct = s.total ? Math.round(s.done / s.total * 100) : 0;
    const late = s.dd < 0;
    const color = late ? '#c0392b' : s.dd <= 3 ? '#b45309' : '#1f3a5f';
    return `
<div style="border:1px solid #d8e0e8;border-radius:12px;margin-bottom:14px;overflow:hidden">
  <div style="background:${color};color:#fff;padding:12px 16px">
    <div style="font-size:16px;font-weight:800">${s.year}년 ${Q_LABEL[s.q] ?? s.q} 숙련도 평가 · ${ddText(s.dd)}</div>
    <div style="font-size:12px;opacity:.85;margin-top:2px">평가 예정일 ${s.evalDate}${late ? ' — 평가일이 지났습니다. 조속히 완료해 주세요.' : ''}</div>
  </div>
  <div style="padding:14px 16px">
    <div style="font-size:14px;margin-bottom:6px">진행률 <b style="font-size:18px">${s.done}</b> / ${s.total}명 승인완료 (${pct}%)</div>
    <div style="height:8px;background:#e8eef4;border-radius:5px;overflow:hidden;margin-bottom:12px">
      <div style="height:8px;width:${pct}%;background:#3f9142"></div></div>
    <table style="border-collapse:collapse;font-size:13.5px;width:100%">
      <tr><td style="padding:6px 10px 6px 0;color:#475569;white-space:nowrap;vertical-align:top;width:92px">미평가 <b style="color:#c0392b">${s.notStarted.length}</b>명</td><td style="padding:6px 0">${names(s.notStarted)}</td></tr>
      <tr><td style="padding:6px 10px 6px 0;color:#475569;white-space:nowrap;vertical-align:top">승인대기 <b style="color:#b45309">${s.pend.length}</b>명</td><td style="padding:6px 0">${names(s.pend)}</td></tr>
      ${s.excluded.length ? `<tr><td style="padding:6px 10px 6px 0;color:#94a3b8;white-space:nowrap;vertical-align:top">대상외 ${s.excluded.length}명</td><td style="padding:6px 0;color:#94a3b8;font-size:12.5px">${s.excluded.map(w => esc(w.name)).join(', ')} — 입사일이 평가일 이후(다음 분기부터 대상)</td></tr>` : ''}
    </table>
  </div>
</div>`;
  }).join('');
  const testBadge = isTest
    ? `<div style="background:#fdf1f1;border:1px solid #f3c0c0;color:#8a2b2b;padding:8px 12px;border-radius:8px;font-size:12px;font-weight:700;margin-bottom:12px">※ 본 메일은 발송 테스트입니다.</div>` : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<div style="font-family:'Malgun Gothic',AppleGothic,sans-serif;font-size:14px;color:#1f2937;max-width:660px">
${testBadge}
<div style="font-size:18px;font-weight:800;color:#1f3a5f;margin-bottom:4px">작업자 숙련도 평가 진행 알림</div>
<div style="font-size:12.5px;color:#64748b;margin-bottom:14px">태진다이텍(주) 품질관리팀 · 평가가 모두 승인완료될 때까지 매일 08:00에 발송됩니다.</div>
${blocks}
<div style="font-size:13px;color:#475569;margin:6px 0 14px">평가자: 강창구 팀장 · 김상기 과장 · 강병주 부장 / 승인대기 건은 팀장 승인이 필요합니다.</div>
<a href="${appUrl}" style="display:inline-block;background:#e8a33d;color:#ffffff;text-decoration:none;font-weight:800;padding:10px 18px;border-radius:9px">평가 시스템 열기</a>
<div style="color:#94a3b8;font-size:11.5px;margin-top:18px;border-top:1px solid #e8eef4;padding-top:10px">
IATF 16949 7.2 적격성 / 현대·기아 SQ 인력관리 기록 &mdash; 본 메일은 자동 발송되었습니다.</div>
</div></body></html>`;
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

    const todayStr = ymd(today);
    const alreadySent = !isTest && !dateParam && cfg.last_sent_on === todayStr;
    if (!sendList.length || alreadySent || isDry) {
      return new Response(JSON.stringify({
        ok: true, today: todayStr, dataKey: kv[0].key, workers: workers.length,
        willSend: sendList.length > 0 && !alreadySent, alreadySent, dry: isDry,
        targets: sendList.map(summary), recipients: cfg.recipients,
      }), { headers: JSONH });
    }

    if (!GMAIL_USER || !GMAIL_PASS) return new Response(JSON.stringify({ ok: false, error: 'GMAIL secret 미설정' }), { status: 500, headers: JSONH });
    const recipients: string[] = cfg.recipients ?? [];
    if (!recipients.length) return new Response(JSON.stringify({ ok: true, skipped: 'no recipients' }), { headers: JSONH });

    const head = sendList[0];
    const doneTxt = sendList.map(s => `${s.q} ${s.done}/${s.total}`).join(', ');
    const subject = isTest
      ? `[TEST] Skill Evaluation Reminder - ${doneTxt} done`
      : `[Taejin Quality] Skill Evaluation ${head.year} ${head.q} ${ddAscii(head.dd)} - ${doneTxt} done`;
    const html = buildHtml(sendList, cfg.app_url, isTest);

    let ok = true, detail = 'sent';
    const client = new SMTPClient({ connection: { hostname: 'smtp.gmail.com', port: 465, tls: true, auth: { username: GMAIL_USER, password: GMAIL_PASS } } });
    try { await client.send({ from: GMAIL_USER, to: recipients, subject, html }); }
    catch (e) { ok = false; detail = String(e).slice(0, 500); }
    finally { try { await client.close(); } catch (_) { /* ignore */ } }

    for (const s of sendList) {
      await sb.from('eval_alarm_log').insert({
        sent_on: todayStr, quarter: `${s.year}-${s.q}`, eval_date: s.evalDate, dday: s.dd,
        recipients, status: ok ? (isTest ? 'test' : 'sent') : 'error', detail, done_cnt: s.done, total_cnt: s.total,
      });
    }
    if (ok && !isTest && !dateParam) await sb.from('eval_alarm_config').update({ last_sent_on: todayStr }).eq('id', 1);

    return new Response(JSON.stringify({ ok, sent: ok, subject, targets: sendList.map(summary), detail }), { headers: JSONH });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: JSONH });
  }
});
