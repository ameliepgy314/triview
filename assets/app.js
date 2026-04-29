// trua launch dashboard — vanilla JS, no build step
const STATE = { config:null, stages:[], team:[], meetings:[], ideas:[], filter:{owner:"",status:"",ideaCat:""} };

const fmtDate = d => {
  if (!d) return "";
  const dt = new Date(d + "T00:00:00");
  return `${dt.getMonth()+1}월 ${dt.getDate()}일`;
};
const today = () => { const t=new Date(); t.setHours(0,0,0,0); return t; };
const daysBetween = (a,b) => Math.round((b-a)/86400000);

async function loadJSON(path){
  const r = await fetch(path + "?t=" + Date.now());
  if (!r.ok) throw new Error("fetch failed: " + path);
  return r.json();
}

async function init(){
  try{
    const [config, stages, team, meetings, ideas] = await Promise.all([
      loadJSON("data/config.json"),
      loadJSON("data/stages.json"),
      loadJSON("data/team.json"),
      loadJSON("data/meetings.json"),
      loadJSON("data/ideas.json"),
    ]);
    STATE.config = config;
    STATE.stages = stages.stages || [];
    STATE.team = team.members || [];
    STATE.meetings = meetings.meetings || [];
    STATE.ideas = ideas.ideas || [];
  }catch(e){
    document.querySelector("main").innerHTML =
      `<div class="card"><h2>데이터 로드 실패</h2><p>data/*.json 파일을 확인해주세요.</p><pre>${e.message}</pre></div>`;
    return;
  }

  setupTabs();
  renderOverview();
  renderStages();
  renderPeople();
  renderMeetings();
  renderIdeas();
  document.getElementById("last-updated").textContent =
    "마지막 데이터 갱신: " + new Date().toLocaleString("ko-KR", {hour12:false});
}

function setupTabs(){
  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const target = btn.dataset.tab;
      document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
      document.getElementById("view-" + target).classList.remove("hidden");
    });
  });
}

// ---------- helpers
function teamById(id){ return STATE.team.find(m => m.id === id); }
function ownerLabel(id){ const m = teamById(id); return m ? m.name : (id || "—"); }
function ownerColor(id){ const m = teamById(id); return m ? m.color : "#9aa3b2"; }
function allTasks(){
  const out = [];
  STATE.stages.forEach(s => (s.tasks||[]).forEach(t => out.push({...t, _stage:s})));
  return out;
}
function stagePct(s){
  const ts = s.tasks||[]; if (!ts.length) return 0;
  const done = ts.filter(t => t.status === "done").length;
  return Math.round(done / ts.length * 100);
}
function dueClass(due){
  if (!due) return "";
  const d = new Date(due+"T00:00:00"); const t = today();
  const diff = daysBetween(t, d);
  if (diff < 0) return "due-over";
  if (diff <= 7) return "due-soon";
  return "";
}

// ---------- overview
function renderOverview(){
  const tasks = allTasks();
  const total = tasks.length;
  const done = tasks.filter(t => t.status === "done").length;
  const doing = tasks.filter(t => t.status === "doing").length;
  const blocked = tasks.filter(t => t.status === "blocked").length;
  const pct = total ? Math.round(done/total*100) : 0;

  document.getElementById("overall-progress").textContent = pct + "%";
  document.getElementById("overall-bar").style.width = pct + "%";
  document.getElementById("overall-foot").textContent = `완료 ${done} / 전체 ${total}`;

  // d-day
  const launch = STATE.config.launchDate;
  if (launch){
    const t = today();
    const ld = new Date(launch+"T00:00:00");
    const diff = daysBetween(t, ld);
    const el = document.getElementById("dday");
    el.textContent = diff > 0 ? `D-${diff}` : (diff === 0 ? "D-DAY" : `D+${Math.abs(diff)}`);
    document.getElementById("dday-foot").textContent = `런칭일 ${launch}`;
  }

  document.getElementById("doing-count").textContent = `${doing} / ${blocked}`;
  document.getElementById("doing-foot").textContent = `진행중 ${doing} · 막힘 ${blocked}`;

  // stage progress list
  const sp = document.getElementById("stage-progress-list");
  sp.innerHTML = STATE.stages.map(s => {
    const pct = stagePct(s);
    return `<div class="row">
      <div class="name">${s.num ? s.num+". " : ""}${s.name}</div>
      <div class="mini-progress"><div style="width:${pct}%"></div></div>
      <div class="pct">${pct}%</div>
    </div>`;
  }).join("") || `<div class="empty">단계가 비어있어요.</div>`;

  // upcoming
  const upcoming = tasks
    .filter(t => t.status !== "done" && t.due)
    .map(t => ({...t, _diff: daysBetween(today(), new Date(t.due+"T00:00:00"))}))
    .filter(t => t._diff <= 14)
    .sort((a,b) => a._diff - b._diff)
    .slice(0, 8);
  const ul = document.getElementById("upcoming-list");
  ul.innerHTML = upcoming.length ? upcoming.map(t => `
    <div class="item">
      <div>
        <div>${t.title}</div>
        <div class="meta">${t._stage.name}${t.owner ? " · "+ownerLabel(t.owner) : ""}</div>
      </div>
      <div class="meta">${t._diff < 0 ? `${Math.abs(t._diff)}일 지남` : (t._diff === 0 ? "오늘" : `D-${t._diff}`)}</div>
    </div>`).join("") : `<div class="empty">2주 이내 마감인 태스크가 없어요.</div>`;

  // recent meetings
  const rm = document.getElementById("recent-meetings");
  rm.innerHTML = STATE.meetings.slice(0,5).map(m => `
    <div class="item">
      <div>
        <div>${m.title}</div>
        <div class="meta">${(m.attendees||[]).join(", ")}</div>
      </div>
      <div class="meta">${m.date}</div>
    </div>`).join("") || `<div class="empty">아직 회의록이 없어요.</div>`;

  // recent ideas
  const ri = document.getElementById("recent-ideas");
  ri.innerHTML = STATE.ideas.slice(0,5).map(i => `
    <div class="item">
      <div>
        <div>${i.title}</div>
        <div class="meta">${i.category}${i.author ? " · "+ownerLabel(i.author) : ""}</div>
      </div>
      <div class="meta">${i.date||""}</div>
    </div>`).join("") || `<div class="empty">아이디어를 추가해보세요.</div>`;
}

// ---------- stages
function renderStages(){
  // populate filters
  const ownerSel = document.getElementById("filter-owner");
  ownerSel.innerHTML = `<option value="">전체</option>` +
    STATE.team.map(m => `<option value="${m.id}">${m.name}</option>`).join("");
  ownerSel.addEventListener("change", e => { STATE.filter.owner = e.target.value; drawStages(); });
  document.getElementById("filter-status").addEventListener("change", e => {
    STATE.filter.status = e.target.value; drawStages();
  });
  drawStages();
}

function drawStages(){
  const root = document.getElementById("stages-list");
  const {owner, status} = STATE.filter;
  root.innerHTML = STATE.stages.map(s => {
    const tasks = (s.tasks||[]).filter(t =>
      (!owner || t.owner === owner) &&
      (!status || t.status === status)
    );
    const pct = stagePct(s);
    const taskHtml = tasks.length ? tasks.map(t => taskRow(t, s)).join("") :
      `<div class="empty">조건에 맞는 태스크가 없어요.</div>`;
    return `<section class="stage">
      <header class="stage-head" data-stage="${s.id}">
        <span class="num">${s.num||""}</span>
        <span class="name">${s.name}</span>
        <span class="desc">${s.description||""}</span>
        <span class="meta">
          <span class="mini-progress"><div style="width:${pct}%"></div></span>
          <span class="pct">${pct}%</span>
        </span>
      </header>
      <div class="stage-body">${taskHtml}</div>
    </section>`;
  }).join("");

  root.querySelectorAll(".stage-head").forEach(h => {
    h.addEventListener("click", () => h.parentElement.classList.toggle("collapsed"));
  });
}

function taskRow(t, stage){
  const due = t.due ? `<span class="pill ${dueClass(t.due)}">${fmtDate(t.due)}</span>` : `<span class="pill">—</span>`;
  const owner = t.owner ? `<span class="owner" style="background:${ownerColor(t.owner)}">${ownerLabel(t.owner)}</span>` : `<span class="pill">미정</span>`;
  const statusPill = `<span class="pill"><span class="dot dot-${t.status||"todo"}"></span>${labelStatus(t.status)}</span>`;
  return `<div class="task ${t.status||"todo"}">
    <span class="tcheck"></span>
    <div>
      <div class="ttitle">${t.title}</div>
      ${t.notes ? `<span class="tnotes">${t.notes}</span>` : ""}
    </div>
    ${statusPill}
    ${owner}
    ${due}
  </div>`;
}
function labelStatus(s){
  return ({todo:"대기",doing:"진행중",done:"완료",blocked:"막힘"})[s] || "대기";
}

// ---------- people
function renderPeople(){
  const root = document.getElementById("people-list");
  root.innerHTML = STATE.team.map(m => {
    const tasks = allTasks().filter(t => t.owner === m.id);
    const done = tasks.filter(t => t.status === "done").length;
    const doing = tasks.filter(t => t.status === "doing").length;
    const todo = tasks.filter(t => !t.status || t.status === "todo").length;
    const blocked = tasks.filter(t => t.status === "blocked").length;
    return `<section class="person">
      <header class="person-head">
        <div class="person-avatar" style="background:${m.color}">${(m.name||"?").slice(0,1)}</div>
        <div>
          <div class="person-name">${m.name}</div>
          <div class="person-role">${m.role||""}</div>
          <div class="person-stats">
            <span>완료 ${done}</span><span>진행 ${doing}</span><span>대기 ${todo}</span>${blocked?`<span style="color:var(--bad)">막힘 ${blocked}</span>`:""}
          </div>
        </div>
      </header>
      <div class="person-tasks">
        ${tasks.filter(t => t.status !== "done").map(t => `
          <div class="person-task">
            <div>
              <div>${t.title}</div>
              <div class="stage-tag">${t._stage.name}${t.due ? " · "+fmtDate(t.due) : ""}</div>
            </div>
            <span class="pill"><span class="dot dot-${t.status||"todo"}"></span>${labelStatus(t.status)}</span>
          </div>`).join("") || `<div class="empty">담당 중인 태스크가 없어요.</div>`}
      </div>
    </section>`;
  }).join("");
}

// ---------- meetings
function renderMeetings(){
  const idx = document.getElementById("meetings-index");
  idx.innerHTML = STATE.meetings.map((m, i) => `
    <div class="meeting-item" data-i="${i}">
      <div class="mt-date">${m.date}</div>
      <div class="mt-title">${m.title}</div>
      <div class="mt-att">${(m.attendees||[]).join(", ")}</div>
    </div>`).join("") || `<div class="empty">아직 회의록이 없어요.</div>`;
  idx.querySelectorAll(".meeting-item").forEach(el => {
    el.addEventListener("click", () => {
      idx.querySelectorAll(".meeting-item").forEach(e => e.classList.remove("active"));
      el.classList.add("active");
      openMeeting(STATE.meetings[+el.dataset.i]);
    });
  });
  if (STATE.meetings.length){
    idx.querySelector(".meeting-item").classList.add("active");
    openMeeting(STATE.meetings[0]);
  }
}

async function openMeeting(m){
  const body = document.getElementById("meeting-body");
  if (!m){ body.innerHTML = `<div class="empty">회의를 선택하세요.</div>`; return; }
  body.innerHTML = `<div class="empty">불러오는 중…</div>`;
  try{
    const r = await fetch(m.file + "?t=" + Date.now());
    if (!r.ok) throw new Error("not found");
    const md = await r.text();
    body.innerHTML = marked.parse(md);
  }catch(e){
    body.innerHTML = `<div class="empty">${m.file} 파일을 찾을 수 없어요.</div>`;
  }
}

// ---------- ideas
function renderIdeas(){
  const cats = [...new Set(STATE.ideas.map(i => i.category).filter(Boolean))];
  const sel = document.getElementById("idea-category");
  sel.innerHTML = `<option value="">전체</option>` + cats.map(c => `<option value="${c}">${c}</option>`).join("");
  sel.addEventListener("change", e => { STATE.filter.ideaCat = e.target.value; drawIdeas(); });
  drawIdeas();
}
function drawIdeas(){
  const grid = document.getElementById("ideas-grid");
  const items = STATE.ideas.filter(i => !STATE.filter.ideaCat || i.category === STATE.filter.ideaCat);
  grid.innerHTML = items.map(i => `
    <article class="idea">
      <div class="ihead">
        <span class="icat">${i.category||""}</span>
        <span class="istatus">${i.status||"논의중"}</span>
      </div>
      <div class="ititle">${i.title}</div>
      <div class="ibody">${i.content||""}</div>
      <div class="ifoot">
        <span>${i.author ? ownerLabel(i.author) : ""}</span>
        <span>${i.date||""}</span>
      </div>
    </article>`).join("") || `<div class="empty">아직 아이디어가 없어요.</div>`;
}

init();
