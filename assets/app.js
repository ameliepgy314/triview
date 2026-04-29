// trua launch dashboard — vanilla JS, no build step
const REPO = { owner: "ameliepgy314", name: "triview", branch: "main" };
const TOKEN_KEY = "trua_gh_token";

const STATE = {
  config:null, stages:[], team:[], meetings:[], ideas:[],
  filter:{owner:"",status:"",ideaCat:""},
  shas:{}, // path -> sha cache
  token:null,
  user:null,
  selectedMeetingFile:null,
  meetingBodyCache:{} // file -> {content, sha}
};
let pendingAuthResolve = null;

const $ = id => document.getElementById(id);

// ---------- date helpers
const fmtDate = d => {
  if (!d) return "";
  const dt = new Date(d + "T00:00:00");
  return `${dt.getMonth()+1}월 ${dt.getDate()}일`;
};
const today = () => { const t=new Date(); t.setHours(0,0,0,0); return t; };
const daysBetween = (a,b) => Math.round((b-a)/86400000);

// ---------- base64 (utf-8 safe)
function b64encode(s){
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  const chunk = 0x8000;
  for (let i=0;i<bytes.length;i+=chunk){
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i+chunk));
  }
  return btoa(bin);
}
function b64decode(s){
  const bin = atob(s.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ---------- gh api
async function ghGet(path){
  const url = `https://api.github.com/repos/${REPO.owner}/${REPO.name}/contents/${encodeURI(path)}?ref=${REPO.branch}`;
  const r = await fetch(url, { headers: ghHeaders() });
  if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
  const data = await r.json();
  STATE.shas[path] = data.sha;
  return { content: b64decode(data.content), sha: data.sha };
}

async function ghPut(path, contentString, message, expectedSha){
  const url = `https://api.github.com/repos/${REPO.owner}/${REPO.name}/contents/${encodeURI(path)}`;
  const body = {
    message,
    content: b64encode(contentString),
    branch: REPO.branch
  };
  if (expectedSha) body.sha = expectedSha;
  const r = await fetch(url, { method:"PUT", headers: ghHeaders(true), body: JSON.stringify(body) });
  if (r.status === 409 || r.status === 422){
    // sha conflict — refetch and retry once
    const fresh = await ghGet(path);
    body.sha = fresh.sha;
    const r2 = await fetch(url, { method:"PUT", headers: ghHeaders(true), body: JSON.stringify(body) });
    if (!r2.ok){
      const txt = await r2.text();
      throw new Error(`PUT ${path}: ${r2.status} ${txt}`);
    }
    const data2 = await r2.json();
    STATE.shas[path] = data2.content.sha;
    return data2;
  }
  if (!r.ok){
    const txt = await r.text();
    throw new Error(`PUT ${path}: ${r.status} ${txt}`);
  }
  const data = await r.json();
  STATE.shas[path] = data.content.sha;
  return data;
}

async function ghDelete(path, message){
  if (!await ensureAuth()) throw new Error("토큰 필요");
  let sha = STATE.shas[path];
  if (!sha){ const fresh = await ghGet(path); sha = fresh.sha; }
  const url = `https://api.github.com/repos/${REPO.owner}/${REPO.name}/contents/${encodeURI(path)}`;
  const r = await fetch(url, {
    method:"DELETE",
    headers: ghHeaders(true),
    body: JSON.stringify({ message, sha, branch: REPO.branch })
  });
  if (!r.ok){
    const txt = await r.text();
    throw new Error(`DELETE ${path}: ${r.status} ${txt}`);
  }
  delete STATE.shas[path];
  return r.json();
}

function ghHeaders(write=false){
  const h = { "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (write) h["Content-Type"] = "application/json";
  if (STATE.token) h["Authorization"] = `Bearer ${STATE.token}`;
  return h;
}

async function validateToken(token){
  const r = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error("토큰이 유효하지 않아.");
  const u = await r.json();
  // also test repo access
  const r2 = await fetch(`https://api.github.com/repos/${REPO.owner}/${REPO.name}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r2.ok) throw new Error("이 리포에 접근 권한이 없어. 토큰 권한을 확인해줘.");
  return u;
}

// ---------- save indicator
let savingCount = 0, saveTimer = null;
function showSaving(label="저장 중…"){
  savingCount++;
  const el = $("save-indicator");
  el.className = "save-indicator saving";
  el.textContent = label;
  el.classList.remove("hidden");
}
function showSaved(){
  savingCount = Math.max(0, savingCount-1);
  if (savingCount>0) return;
  const el = $("save-indicator");
  el.className = "save-indicator saved";
  el.textContent = "저장됨";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => el.classList.add("hidden"), 1500);
}
function showError(msg){
  savingCount = 0;
  const el = $("save-indicator");
  el.className = "save-indicator error";
  el.textContent = "오류: " + msg;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => el.classList.add("hidden"), 4000);
}

// ---------- save helpers
async function saveJSON(path, obj, message){
  if (!await ensureAuth()) throw new Error("토큰 필요");
  showSaving();
  try{
    const text = JSON.stringify(obj, null, 2) + "\n";
    await ghPut(path, text, message, STATE.shas[path]);
    showSaved();
  }catch(e){
    showError(e.message);
    throw e;
  }
}
async function saveText(path, text, message, expectedSha){
  if (!await ensureAuth()) throw new Error("토큰 필요");
  showSaving();
  try{
    const res = await ghPut(path, text, message, expectedSha);
    showSaved();
    return res;
  }catch(e){
    showError(e.message);
    throw e;
  }
}

// ---------- init
async function init(){
  STATE.token = localStorage.getItem(TOKEN_KEY);
  try{
    const [config, stages, team, meetings, ideas] = await Promise.all([
      loadInitial("data/config.json"),
      loadInitial("data/stages.json"),
      loadInitial("data/team.json"),
      loadInitial("data/meetings.json"),
      loadInitial("data/ideas.json"),
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
  setupTokenButton();
  setupDialogs();
  renderAll();
  $("last-updated").textContent = "마지막 갱신: " + new Date().toLocaleString("ko-KR", {hour12:false});

  // Validate any saved token in the background to set authed UI state
  if (STATE.token){
    validateToken(STATE.token)
      .then(u => { STATE.user = u; updateTokenButton(); })
      .catch(() => { /* leave token; will fail on first save and re-prompt */ updateTokenButton(); });
  } else {
    updateTokenButton();
  }
}

async function loadInitial(path){
  // try via raw fetch (Pages CDN) — fast, no auth needed
  try{
    const r = await fetch(path + "?t=" + Date.now());
    if (r.ok) return await r.json();
  }catch(e){}
  // fallback: gh API
  const { content } = await ghGet(path);
  return JSON.parse(content);
}

function renderAll(){
  renderOverview();
  renderStages();
  renderPeople();
  renderMeetings();
  renderIdeas();
  populateOwnerSelects();
}

function populateOwnerSelects(){
  // task owner select in modal
  const opts = `<option value="">미정</option>` +
    STATE.team.map(m => `<option value="${m.id}">${m.name}</option>`).join("");
  $("task-owner").innerHTML = opts;
  $("idea-author").innerHTML = `<option value="">—</option>` +
    STATE.team.map(m => `<option value="${m.id}">${m.name}</option>`).join("");
}

// ---------- tabs
function setupTabs(){
  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const target = btn.dataset.tab;
      document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
      $("view-" + target).classList.remove("hidden");
    });
  });
}

// ---------- token / auth
function setupTokenButton(){
  $("token-btn").addEventListener("click", () => openTokenModal());
  if (STATE.config?.launchDate) $("launch-date-edit").value = STATE.config.launchDate;
}

function updateTokenButton(){
  const btn = $("token-btn");
  if (STATE.token && STATE.user){
    btn.classList.add("authed");
    $("token-btn-label").textContent = STATE.user.login;
  } else if (STATE.token){
    btn.classList.add("authed");
    $("token-btn-label").textContent = "토큰";
  } else {
    btn.classList.remove("authed");
    $("token-btn-label").textContent = "로그인";
  }
}

function openTokenModal(){
  $("token-input").value = "";
  $("token-error").textContent = "";
  $("token-modal").showModal();
}

// resolves true if token is set (eventually), false if user cancelled
function ensureAuth(){
  if (STATE.token) return Promise.resolve(true);
  return new Promise(resolve => {
    pendingAuthResolve = resolve;
    openTokenModal();
  });
}

function setupDialogs(){
  // token modal
  $("token-cancel").addEventListener("click", () => {
    $("token-modal").close();
    if (pendingAuthResolve){ pendingAuthResolve(false); pendingAuthResolve = null; }
  });
  $("token-save").addEventListener("click", async () => {
    const t = $("token-input").value.trim();
    if (!t){ $("token-error").textContent = "토큰을 입력해줘."; return; }
    $("token-error").textContent = "확인 중…";
    try{
      const u = await validateToken(t);
      STATE.token = t;
      STATE.user = u;
      localStorage.setItem(TOKEN_KEY, t);
      $("token-modal").close();
      updateTokenButton();
      if (pendingAuthResolve){ pendingAuthResolve(true); pendingAuthResolve = null; }
    }catch(e){
      $("token-error").textContent = e.message;
    }
  });

  // launch date editor
  $("launch-date-edit").addEventListener("change", async (e) => {
    const v = e.target.value;
    if (!v) return;
    STATE.config.launchDate = v;
    await saveJSON("data/config.json", STATE.config, `config: 런칭일 → ${v}`);
    renderOverview();
  });

  // task modal
  $("task-cancel").addEventListener("click", () => $("task-modal").close());
  $("task-save").addEventListener("click", saveTaskFromModal);
  $("stage-cancel").addEventListener("click", () => $("stage-modal").close());
  $("stage-save").addEventListener("click", saveStageFromModal);
  $("btn-add-stage").addEventListener("click", () => openStageModal());

  // idea modal
  $("idea-cancel").addEventListener("click", () => $("idea-modal").close());
  $("idea-save").addEventListener("click", saveIdeaFromModal);
  $("btn-add-idea").addEventListener("click", () => openIdeaModal());

  // member modal
  $("member-cancel").addEventListener("click", () => $("member-modal").close());
  $("member-save").addEventListener("click", saveMemberFromModal);
  $("btn-add-member").addEventListener("click", () => openMemberModal());

  // meeting modal
  $("meeting-cancel").addEventListener("click", () => $("meeting-modal").close());
  $("meeting-save").addEventListener("click", saveMeetingFromModal);
  $("btn-add-meeting").addEventListener("click", () => openMeetingModal());

  // confirm modal
  $("confirm-cancel").addEventListener("click", () => $("confirm-modal").close());
}

let confirmAction = null;
function confirmThen(text, fn){
  $("confirm-text").textContent = text;
  confirmAction = fn;
  const ok = $("confirm-ok");
  ok.onclick = async () => {
    $("confirm-modal").close();
    if (confirmAction) await confirmAction();
    confirmAction = null;
  };
  $("confirm-modal").showModal();
}

// ---------- helpers
function teamById(id){ return STATE.team.find(m => m.id === id); }
function teamByName(name){ return STATE.team.find(m => m.name === name); }
function ownerLabel(id){ const m = teamById(id); return m ? m.name : (id || "—"); }
function ownerColor(id){ const m = teamById(id); return m ? m.color : "#9aa3b2"; }
function authorChip(authorId){
  if (!authorId) return "";
  const m = teamById(authorId);
  if (!m) return `<span class="author-chip attendee-chip-muted">${escapeHtml(authorId)}</span>`;
  return `<span class="author-chip" style="background:${m.color}">${escapeHtml(m.name)}</span>`;
}
function attendeeChips(names){
  if (!names || !names.length) return "";
  return names.map(n => {
    const m = teamByName(n);
    const color = m ? m.color : null;
    const cls = color ? "" : " attendee-chip-muted";
    const style = color ? ` style="background:${color}"` : "";
    return `<span class="attendee-chip${cls}"${style}>${escapeHtml(n)}</span>`;
  }).join("");
}
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
function escapeHtml(s){
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, c =>
    ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function uid(prefix="id"){
  return prefix + "_" + Math.random().toString(36).slice(2,8) + Date.now().toString(36).slice(-3);
}
function slugify(s){
  return s.replace(/\s+/g,"-").replace(/[^\w가-힣\-_.]/g,"").slice(0,60);
}

// ---------- overview
function renderOverview(){
  const tasks = allTasks();
  const total = tasks.length;
  const done = tasks.filter(t => t.status === "done").length;
  const doing = tasks.filter(t => t.status === "doing").length;
  const blocked = tasks.filter(t => t.status === "blocked").length;
  const pct = total ? Math.round(done/total*100) : 0;

  $("overall-progress").textContent = pct + "%";
  $("overall-bar").style.width = pct + "%";
  $("overall-foot").textContent = `완료 ${done} / 전체 ${total}`;

  const launch = STATE.config.launchDate;
  if (launch){
    const t = today();
    const ld = new Date(launch+"T00:00:00");
    const diff = daysBetween(t, ld);
    const el = $("dday");
    el.textContent = diff > 0 ? `D-${diff}` : (diff === 0 ? "D-DAY" : `D+${Math.abs(diff)}`);
    $("dday-foot").textContent = `런칭일 ${launch}`;
    $("launch-date-edit").value = launch;
  }

  $("doing-count").textContent = `${doing} / ${blocked}`;
  $("doing-foot").textContent = `진행중 ${doing} · 막힘 ${blocked}`;

  const sp = $("stage-progress-list");
  sp.innerHTML = STATE.stages.map(s => {
    const pct = stagePct(s);
    return `<div class="row">
      <div class="name">${s.num ? escapeHtml(s.num)+". " : ""}${escapeHtml(s.name)}</div>
      <div class="mini-progress"><div style="width:${pct}%"></div></div>
      <div class="pct">${pct}%</div>
    </div>`;
  }).join("") || `<div class="empty">단계가 비어있어요.</div>`;

  const upcoming = tasks
    .filter(t => t.status !== "done" && t.due)
    .map(t => ({...t, _diff: daysBetween(today(), new Date(t.due+"T00:00:00"))}))
    .filter(t => t._diff <= 14)
    .sort((a,b) => a._diff - b._diff)
    .slice(0, 8);
  $("upcoming-list").innerHTML = upcoming.length ? upcoming.map(t => `
    <div class="item">
      <div>
        <div>${escapeHtml(t.title)}</div>
        <div class="meta">${escapeHtml(t._stage.name)}${t.owner ? " · "+escapeHtml(ownerLabel(t.owner)) : ""}</div>
      </div>
      <div class="meta">${t._diff < 0 ? `${Math.abs(t._diff)}일 지남` : (t._diff === 0 ? "오늘" : `D-${t._diff}`)}</div>
    </div>`).join("") : `<div class="empty">2주 이내 마감인 태스크가 없어요.</div>`;

  $("recent-meetings").innerHTML = STATE.meetings.slice(0,5).map(m => `
    <div class="item">
      <div>
        <div>${escapeHtml(m.title)}</div>
        <div class="meta attendees-row">${attendeeChips(m.attendees)}</div>
      </div>
      <div class="meta">${escapeHtml(m.date)}</div>
    </div>`).join("") || `<div class="empty">아직 회의록이 없어요.</div>`;

  $("recent-ideas").innerHTML = STATE.ideas.slice(0,5).map(i => `
    <div class="item">
      <div>
        <div>${escapeHtml(i.title)}</div>
        <div class="meta">${escapeHtml(i.category)} ${authorChip(i.author)}</div>
      </div>
      <div class="meta">${escapeHtml(i.date||"")}</div>
    </div>`).join("") || `<div class="empty">아이디어를 추가해보세요.</div>`;
}

// ---------- stages
function renderStages(){
  const ownerSel = $("filter-owner");
  ownerSel.innerHTML = `<option value="">전체</option>` +
    STATE.team.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join("");
  ownerSel.value = STATE.filter.owner || "";
  ownerSel.onchange = e => { STATE.filter.owner = e.target.value; drawStages(); };
  $("filter-status").onchange = e => { STATE.filter.status = e.target.value; drawStages(); };
  drawStages();
}

function drawStages(){
  const root = $("stages-list");
  const {owner, status} = STATE.filter;
  root.innerHTML = STATE.stages.map(s => {
    const tasks = (s.tasks||[]).filter(t =>
      (!owner || t.owner === owner) &&
      (!status || t.status === status)
    );
    const pct = stagePct(s);
    const taskHtml = tasks.length ? tasks.map(t => taskRow(t, s)).join("") :
      `<div class="empty">조건에 맞는 태스크가 없어요.</div>`;
    return `<section class="stage" data-stage-id="${s.id}">
      <header class="stage-head">
        <span class="num">${escapeHtml(s.num||"")}</span>
        <span class="name" data-field="name">${escapeHtml(s.name)}</span>
        <span class="desc" data-field="description">${escapeHtml(s.description||"")}</span>
        <span class="stage-actions">
          <button class="btn-icon" data-act="edit-stage" title="단계 편집">✎</button>
          <button class="btn-icon danger" data-act="delete-stage" title="단계 삭제">×</button>
        </span>
        <span class="meta">
          <span class="mini-progress"><div style="width:${pct}%"></div></span>
          <span class="pct">${pct}%</span>
        </span>
      </header>
      <div class="stage-body">${taskHtml}
        <div class="add-task-row">
          <button class="btn btn-ghost" data-act="add-task">+ 태스크 추가</button>
        </div>
      </div>
    </section>`;
  }).join("");

  // collapse only via num click (not the whole header — it'd interfere with editing)
  root.querySelectorAll(".stage-head .num").forEach(el => {
    el.addEventListener("click", () => el.closest(".stage").classList.toggle("collapsed"));
  });

  // task action delegation
  root.querySelectorAll(".stage").forEach(stEl => {
    const stageId = stEl.dataset.stageId;

    stEl.querySelector('[data-act="add-task"]').addEventListener("click", () => openTaskModal(stageId));
    const editStageBtn = stEl.querySelector('[data-act="edit-stage"]');
    editStageBtn.addEventListener("click", () => openStageModal(stageId));
    stEl.querySelector('[data-act="delete-stage"]').addEventListener("click", () => deleteStage(stageId));

    stEl.querySelectorAll(".task").forEach(taskEl => {
      const taskId = taskEl.dataset.taskId;
      const editBtn = taskEl.querySelector('[data-act="edit-task"]');
      const delBtn = taskEl.querySelector('[data-act="delete-task"]');
      const statusSel = taskEl.querySelector('select.status-sel');
      const ownerSel = taskEl.querySelector('select.owner-sel');
      const dueIn = taskEl.querySelector('input.due-in');
      const titleEl = taskEl.querySelector('.ttitle');
      if (editBtn) editBtn.addEventListener("click", () => openTaskModal(stageId, taskId));
      if (delBtn) delBtn.addEventListener("click", () => deleteTask(stageId, taskId));
      if (statusSel) statusSel.addEventListener("change", e => updateTaskField(stageId, taskId, "status", e.target.value));
      if (ownerSel) ownerSel.addEventListener("change", e => updateTaskField(stageId, taskId, "owner", e.target.value));
      if (dueIn) dueIn.addEventListener("change", e => updateTaskField(stageId, taskId, "due", e.target.value));
      if (titleEl){
        titleEl.addEventListener("click", () => titleEl.setAttribute("contenteditable","true"));
        titleEl.addEventListener("blur", () => {
          if (titleEl.getAttribute("contenteditable") !== "true") return;
          titleEl.removeAttribute("contenteditable");
          const newTitle = titleEl.textContent.trim();
          if (newTitle) updateTaskField(stageId, taskId, "title", newTitle);
          else titleEl.textContent = stage.tasks.find(t=>t.id===taskId)?.title || "";
        });
        titleEl.addEventListener("keydown", e => { if (e.key === "Enter"){ e.preventDefault(); titleEl.blur(); } });
      }
    });
  });
}

function taskRow(t, stage){
  const statusSel = `<select class="inline status-sel">
    ${["todo","doing","done","blocked"].map(s => `<option value="${s}" ${s===(t.status||"todo")?"selected":""}>${labelStatus(s)}</option>`).join("")}
  </select>`;
  const ownerOpts = [`<option value="">미정</option>`].concat(
    STATE.team.map(m => `<option value="${m.id}" ${m.id===t.owner?"selected":""}>${escapeHtml(m.name)}</option>`)
  ).join("");
  const ownerColorStyle = t.owner
    ? `style="background:${ownerColor(t.owner)};color:#fff;border:0"`
    : `style="background:#f1f3f7;color:#7b8494"`;
  const ownerSel = `<select class="inline owner-sel" ${ownerColorStyle}>${ownerOpts}</select>`;
  const dueIn = `<input type="date" class="inline-date due-in ${dueClass(t.due)}" value="${t.due||""}">`;

  return `<div class="task ${t.status||"todo"}" data-task-id="${escapeHtml(t.id)}">
    <span class="tcheck"></span>
    <div>
      <div class="ttitle">${escapeHtml(t.title)}</div>
      ${t.notes ? `<span class="tnotes">${escapeHtml(t.notes)}</span>` : ""}
    </div>
    ${statusSel}
    ${ownerSel}
    ${dueIn}
    <span class="task-actions">
      <button class="btn-icon" data-act="edit-task" title="자세히 편집">✎</button>
      <button class="btn-icon danger" data-act="delete-task" title="삭제">×</button>
    </span>
  </div>`;
}
function labelStatus(s){
  return ({todo:"대기",doing:"진행중",done:"완료",blocked:"막힘"})[s] || "대기";
}

async function updateTaskField(stageId, taskId, field, value){
  const stage = STATE.stages.find(s => s.id === stageId);
  if (!stage) return;
  const task = (stage.tasks||[]).find(t => t.id === taskId);
  if (!task) return;
  if (task[field] === value) return;
  task[field] = value;
  try{
    await saveJSON("data/stages.json", { stages: STATE.stages },
      `task ${taskId}: ${field} → ${value || "(empty)"}`);
    drawStages();
    renderOverview();
    renderPeople();
  }catch(e){
    // already shown in showError
  }
}

function openTaskModal(stageId, taskId){
  $("task-stage-id").value = stageId;
  $("task-edit-id").value = taskId || "";
  $("task-error").textContent = "";
  if (taskId){
    const stage = STATE.stages.find(s => s.id === stageId);
    const t = stage.tasks.find(x => x.id === taskId);
    $("task-modal-title").textContent = "태스크 편집";
    $("task-title").value = t.title || "";
    $("task-owner").value = t.owner || "";
    $("task-status").value = t.status || "todo";
    $("task-due").value = t.due || "";
    $("task-notes").value = t.notes || "";
  } else {
    $("task-modal-title").textContent = "새 태스크";
    $("task-title").value = "";
    $("task-owner").value = "";
    $("task-status").value = "todo";
    $("task-due").value = "";
    $("task-notes").value = "";
  }
  $("task-modal").showModal();
  setTimeout(() => $("task-title").focus(), 50);
}

async function saveTaskFromModal(){
  const stageId = $("task-stage-id").value;
  const editId = $("task-edit-id").value;
  const title = $("task-title").value.trim();
  if (!title){ $("task-error").textContent = "제목은 필수야."; return; }
  const stage = STATE.stages.find(s => s.id === stageId);
  if (!stage){ $("task-error").textContent = "단계를 못 찾음."; return; }
  const data = {
    title,
    owner: $("task-owner").value || undefined,
    status: $("task-status").value,
    due: $("task-due").value || undefined,
    notes: $("task-notes").value || undefined
  };
  if (editId){
    const t = stage.tasks.find(x => x.id === editId);
    Object.assign(t, data);
  } else {
    stage.tasks = stage.tasks || [];
    stage.tasks.push({ id: uid("t"), ...data });
  }
  try{
    await saveJSON("data/stages.json", { stages: STATE.stages },
      `task: ${editId ? "edit" : "add"} "${title}"`);
    $("task-modal").close();
    drawStages();
    renderOverview();
    renderPeople();
  }catch(e){
    $("task-error").textContent = e.message;
  }
}

function deleteTask(stageId, taskId){
  const stage = STATE.stages.find(s => s.id === stageId);
  const task = stage.tasks.find(t => t.id === taskId);
  if (!task) return;
  confirmThen(`"${task.title}" 태스크를 삭제할까?`, async () => {
    stage.tasks = stage.tasks.filter(t => t.id !== taskId);
    await saveJSON("data/stages.json", { stages: STATE.stages },
      `task: delete "${task.title}"`);
    drawStages();
    renderOverview();
    renderPeople();
  });
}

function openStageModal(stageId){
  $("stage-edit-id").value = stageId || "";
  $("stage-error").textContent = "";
  if (stageId){
    const s = STATE.stages.find(x => x.id === stageId);
    $("stage-modal-title").textContent = "단계 편집";
    $("stage-num").value = s.num || "";
    $("stage-id").value = s.id;
    $("stage-id").disabled = true;
    $("stage-name").value = s.name || "";
    $("stage-desc").value = s.description || "";
  } else {
    $("stage-modal-title").textContent = "새 단계";
    const next = (STATE.stages.length+1).toString().padStart(2,"0");
    $("stage-num").value = next;
    $("stage-id").value = "";
    $("stage-id").disabled = false;
    $("stage-name").value = "";
    $("stage-desc").value = "";
  }
  $("stage-modal").showModal();
}

async function saveStageFromModal(){
  const editId = $("stage-edit-id").value;
  const name = $("stage-name").value.trim();
  const id = ($("stage-id").value || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g,"");
  if (!name){ $("stage-error").textContent = "이름은 필수."; return; }
  if (!editId && !id){ $("stage-error").textContent = "ID는 영문/숫자로."; return; }
  if (editId){
    const s = STATE.stages.find(x => x.id === editId);
    s.num = $("stage-num").value;
    s.name = name;
    s.description = $("stage-desc").value;
  } else {
    if (STATE.stages.find(s => s.id === id)){
      $("stage-error").textContent = "이미 존재하는 ID야."; return;
    }
    STATE.stages.push({
      id, num: $("stage-num").value, name,
      description: $("stage-desc").value, tasks: []
    });
  }
  try{
    await saveJSON("data/stages.json", { stages: STATE.stages },
      `stage: ${editId ? "edit" : "add"} "${name}"`);
    $("stage-modal").close();
    drawStages();
    renderOverview();
  }catch(e){
    $("stage-error").textContent = e.message;
  }
}

function deleteStage(stageId){
  const s = STATE.stages.find(x => x.id === stageId);
  if (!s) return;
  confirmThen(`"${s.name}" 단계와 ${s.tasks?.length||0}개 태스크를 모두 삭제할까?`, async () => {
    STATE.stages = STATE.stages.filter(x => x.id !== stageId);
    await saveJSON("data/stages.json", { stages: STATE.stages },
      `stage: delete "${s.name}"`);
    drawStages();
    renderOverview();
    renderPeople();
  });
}

// ---------- people
function renderPeople(){
  const root = $("people-list");
  root.innerHTML = STATE.team.map(m => {
    const tasks = allTasks().filter(t => t.owner === m.id);
    const done = tasks.filter(t => t.status === "done").length;
    const doing = tasks.filter(t => t.status === "doing").length;
    const todo = tasks.filter(t => !t.status || t.status === "todo").length;
    const blocked = tasks.filter(t => t.status === "blocked").length;
    return `<section class="person" data-mid="${m.id}">
      <header class="person-head">
        <div class="person-avatar" style="background:${m.color}">${escapeHtml((m.name||"?").slice(0,1))}</div>
        <div>
          <div class="person-name">${escapeHtml(m.name)}</div>
          <div class="person-role">${escapeHtml(m.role||"")}</div>
          <div class="person-stats">
            <span>완료 ${done}</span><span>진행 ${doing}</span><span>대기 ${todo}</span>${blocked?`<span style="color:var(--bad)">막힘 ${blocked}</span>`:""}
          </div>
        </div>
        <span class="person-actions">
          <button class="btn-icon" data-act="edit-member" title="편집">✎</button>
          <button class="btn-icon danger" data-act="delete-member" title="삭제">×</button>
        </span>
      </header>
      <div class="person-tasks">
        ${tasks.filter(t => t.status !== "done").map(t => `
          <div class="person-task">
            <div>
              <div>${escapeHtml(t.title)}</div>
              <div class="stage-tag">${escapeHtml(t._stage.name)}${t.due ? " · "+fmtDate(t.due) : ""}</div>
            </div>
            <span class="pill"><span class="dot dot-${t.status||"todo"}"></span>${labelStatus(t.status)}</span>
          </div>`).join("") || `<div class="empty">담당 중인 태스크가 없어요.</div>`}
      </div>
    </section>`;
  }).join("");

  root.querySelectorAll(".person").forEach(el => {
    const id = el.dataset.mid;
    el.querySelector('[data-act="edit-member"]').addEventListener("click", () => openMemberModal(id));
    el.querySelector('[data-act="delete-member"]').addEventListener("click", () => deleteMember(id));
  });
}

function openMemberModal(id){
  $("member-edit-id").value = id || "";
  $("member-error").textContent = "";
  if (id){
    const m = STATE.team.find(x => x.id === id);
    $("member-modal-title").textContent = "멤버 편집";
    $("member-id").value = m.id;
    $("member-id").disabled = true;
    $("member-name").value = m.name;
    $("member-role").value = m.role || "";
    $("member-color").value = m.color || "#2563eb";
  } else {
    $("member-modal-title").textContent = "새 멤버";
    $("member-id").value = "";
    $("member-id").disabled = false;
    $("member-name").value = "";
    $("member-role").value = "";
    $("member-color").value = "#" + Math.floor(Math.random()*0xffffff).toString(16).padStart(6,"0");
  }
  $("member-modal").showModal();
}

async function saveMemberFromModal(){
  const editId = $("member-edit-id").value;
  const name = $("member-name").value.trim();
  if (!name){ $("member-error").textContent = "이름은 필수."; return; }
  const id = ($("member-id").value || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g,"");
  if (!editId && !id){ $("member-error").textContent = "ID는 영문/숫자로."; return; }
  if (editId){
    const m = STATE.team.find(x => x.id === editId);
    m.name = name;
    m.role = $("member-role").value;
    m.color = $("member-color").value;
  } else {
    if (STATE.team.find(x => x.id === id)){ $("member-error").textContent = "이미 존재하는 ID."; return; }
    STATE.team.push({ id, name, role: $("member-role").value, color: $("member-color").value });
  }
  try{
    await saveJSON("data/team.json", { members: STATE.team },
      `team: ${editId ? "edit" : "add"} ${name}`);
    $("member-modal").close();
    populateOwnerSelects();
    renderPeople();
    drawStages();
  }catch(e){
    $("member-error").textContent = e.message;
  }
}

function deleteMember(id){
  const m = STATE.team.find(x => x.id === id);
  if (!m) return;
  const refs = allTasks().filter(t => t.owner === id).length +
    STATE.ideas.filter(i => i.author === id).length;
  confirmThen(`"${m.name}" 멤버를 삭제할까? (${refs}개 항목에서 owner 참조됨 — 미정 처리됨)`, async () => {
    STATE.team = STATE.team.filter(x => x.id !== id);
    // null out owner refs
    STATE.stages.forEach(s => (s.tasks||[]).forEach(t => { if (t.owner === id) t.owner = undefined; }));
    STATE.ideas.forEach(i => { if (i.author === id) i.author = undefined; });
    await saveJSON("data/team.json", { members: STATE.team }, `team: delete ${m.name}`);
    if (refs){
      await saveJSON("data/stages.json", { stages: STATE.stages }, `stages: clear owner refs to ${m.name}`);
      await saveJSON("data/ideas.json", { ideas: STATE.ideas }, `ideas: clear author refs to ${m.name}`);
    }
    populateOwnerSelects();
    renderPeople();
    drawStages();
  });
}

// ---------- meetings
function renderMeetings(){
  const idx = $("meetings-index");
  idx.innerHTML = STATE.meetings.map((m, i) => `
    <div class="meeting-item" data-i="${i}" data-file="${escapeHtml(m.file)}">
      <div class="mt-date">${escapeHtml(m.date)}</div>
      <div class="mt-title">${escapeHtml(m.title)}</div>
      <div class="mt-att attendees-row">${attendeeChips(m.attendees)}</div>
      <div class="meeting-actions">
        <button class="btn-icon" data-act="edit-meeting" title="편집">✎</button>
        <button class="btn-icon danger" data-act="delete-meeting" title="삭제">×</button>
      </div>
    </div>`).join("") || `<div class="empty">아직 회의록이 없어요.</div>`;

  idx.querySelectorAll(".meeting-item").forEach(el => {
    const i = +el.dataset.i;
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-act]")) return;
      idx.querySelectorAll(".meeting-item").forEach(e => e.classList.remove("active"));
      el.classList.add("active");
      openMeeting(STATE.meetings[i]);
    });
    const editBtn = el.querySelector('[data-act="edit-meeting"]');
    const delBtn = el.querySelector('[data-act="delete-meeting"]');
    if (editBtn) editBtn.addEventListener("click", () => openMeetingModal(i));
    if (delBtn) delBtn.addEventListener("click", () => deleteMeeting(i));
  });
  if (STATE.meetings.length){
    const sel = STATE.selectedMeetingFile
      ? idx.querySelector(`.meeting-item[data-file="${STATE.selectedMeetingFile}"]`)
      : idx.querySelector(".meeting-item");
    if (sel){
      sel.classList.add("active");
      const i = +sel.dataset.i;
      openMeeting(STATE.meetings[i]);
    }
  }
}

async function openMeeting(m){
  const body = $("meeting-body");
  if (!m){ body.innerHTML = `<div class="empty">회의를 선택하세요.</div>`; return; }
  STATE.selectedMeetingFile = m.file;
  body.innerHTML = `<div class="empty">불러오는 중…</div>`;
  try{
    let md;
    const cached = STATE.meetingBodyCache[m.file];
    if (cached) md = cached.content;
    else {
      const r = await fetch(m.file + "?t=" + Date.now());
      if (r.ok) md = await r.text();
      else throw new Error("not found");
    }
    body.innerHTML = marked.parse(md);
  }catch(e){
    body.innerHTML = `<div class="empty">${escapeHtml(m.file)} 파일을 찾을 수 없어요.</div>`;
  }
}

function openMeetingModal(i){
  $("meeting-error").textContent = "";
  if (i != null){
    const m = STATE.meetings[i];
    $("meeting-modal-title").textContent = "회의록 편집";
    $("meeting-date").value = m.date;
    $("meeting-title").value = m.title;
    $("meeting-attendees").value = (m.attendees||[]).join(", ");
    $("meeting-modal").dataset.editIndex = i;
    // load body
    const cached = STATE.meetingBodyCache[m.file];
    if (cached){
      $("meeting-body-input").value = cached.content;
    } else {
      $("meeting-body-input").value = "불러오는 중…";
      ghGet(m.file).then(({content, sha}) => {
        STATE.meetingBodyCache[m.file] = { content, sha };
        $("meeting-body-input").value = content;
      }).catch(() => {
        fetch(m.file + "?t=" + Date.now()).then(r => r.text()).then(t => {
          $("meeting-body-input").value = t;
        });
      });
    }
  } else {
    $("meeting-modal-title").textContent = "새 회의록";
    $("meeting-date").value = new Date().toISOString().slice(0,10);
    $("meeting-title").value = "";
    $("meeting-attendees").value = STATE.team.map(m => m.name).join(", ");
    $("meeting-body-input").value = "## 결정사항\n- \n\n## 액션 아이템\n- [ ] \n\n## 다음 회의\n- ";
    delete $("meeting-modal").dataset.editIndex;
  }
  $("meeting-modal").showModal();
}

async function saveMeetingFromModal(){
  const date = $("meeting-date").value;
  const title = $("meeting-title").value.trim();
  const attendees = $("meeting-attendees").value.split(",").map(s => s.trim()).filter(Boolean);
  const body = $("meeting-body-input").value;
  if (!date || !title){ $("meeting-error").textContent = "날짜와 제목은 필수."; return; }

  const editIndex = $("meeting-modal").dataset.editIndex;
  try{
    if (editIndex != null){
      const i = +editIndex;
      const m = STATE.meetings[i];
      const oldFile = m.file;
      const newFile = `data/meetings/${date}-${slugify(title)}.md`;
      const fileMoved = oldFile !== newFile;

      // build full md with header
      const md = buildMeetingMarkdown(title, date, attendees, body);
      if (fileMoved){
        await saveText(newFile, md, `meeting: rename ${oldFile} → ${newFile}`);
        await ghDelete(oldFile, `meeting: delete old ${oldFile}`);
        m.file = newFile;
        delete STATE.meetingBodyCache[oldFile];
      } else {
        const sha = STATE.meetingBodyCache[oldFile]?.sha || STATE.shas[oldFile];
        await saveText(oldFile, md, `meeting: edit "${title}"`, sha);
      }
      STATE.meetingBodyCache[m.file] = { content: md, sha: STATE.shas[m.file] };
      m.date = date; m.title = title; m.attendees = attendees;
      await saveJSON("data/meetings.json", { meetings: STATE.meetings },
        `meetings: edit "${title}"`);
      STATE.selectedMeetingFile = m.file;
    } else {
      const newFile = `data/meetings/${date}-${slugify(title)}.md`;
      const md = buildMeetingMarkdown(title, date, attendees, body);
      await saveText(newFile, md, `meeting: add "${title}"`);
      const newEntry = { date, title, file: newFile, attendees };
      STATE.meetings = [newEntry, ...STATE.meetings].sort((a,b) => b.date.localeCompare(a.date));
      await saveJSON("data/meetings.json", { meetings: STATE.meetings },
        `meetings: add "${title}"`);
      STATE.meetingBodyCache[newFile] = { content: md, sha: STATE.shas[newFile] };
      STATE.selectedMeetingFile = newFile;
    }
    $("meeting-modal").close();
    renderMeetings();
    renderOverview();
  }catch(e){
    $("meeting-error").textContent = e.message;
  }
}

function buildMeetingMarkdown(title, date, attendees, body){
  return `# ${title}\n\n- **일시**: ${date}\n- **참석**: ${attendees.join(", ")}\n\n${body.trim()}\n`;
}

function deleteMeeting(i){
  const m = STATE.meetings[i];
  confirmThen(`"${m.title}" 회의록을 삭제할까?`, async () => {
    try{
      await ghDelete(m.file, `meetings: delete file ${m.file}`).catch(()=>{});
      STATE.meetings = STATE.meetings.filter((_,idx) => idx !== i);
      delete STATE.meetingBodyCache[m.file];
      if (STATE.selectedMeetingFile === m.file) STATE.selectedMeetingFile = null;
      await saveJSON("data/meetings.json", { meetings: STATE.meetings },
        `meetings: delete "${m.title}"`);
      renderMeetings();
      renderOverview();
    }catch(e){ showError(e.message); }
  });
}

// ---------- ideas
function renderIdeas(){
  const cats = [...new Set(STATE.ideas.map(i => i.category).filter(Boolean))];
  const sel = $("idea-category");
  sel.innerHTML = `<option value="">전체</option>` + cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  sel.value = STATE.filter.ideaCat || "";
  sel.onchange = e => { STATE.filter.ideaCat = e.target.value; drawIdeas(); };
  // datalist for category input in modal
  $("idea-cat-list").innerHTML = cats.map(c => `<option value="${escapeHtml(c)}">`).join("");
  drawIdeas();
}
function drawIdeas(){
  const grid = $("ideas-grid");
  const items = STATE.ideas.filter(i => !STATE.filter.ideaCat || i.category === STATE.filter.ideaCat);
  grid.innerHTML = items.map(i => {
    const m = teamById(i.author);
    const borderStyle = m ? `style="border-left:4px solid ${m.color}"` : "";
    return `<article class="idea" ${borderStyle} data-iid="${escapeHtml(i.id)}">
      <div class="idea-actions">
        <button class="btn-icon" data-act="edit-idea" title="편집">✎</button>
        <button class="btn-icon danger" data-act="delete-idea" title="삭제">×</button>
      </div>
      <div class="ihead">
        <span class="icat">${escapeHtml(i.category||"")}</span>
        <span class="istatus">${escapeHtml(i.status||"논의중")}</span>
      </div>
      <div class="ititle">${escapeHtml(i.title)}</div>
      <div class="ibody">${escapeHtml(i.content||"")}</div>
      <div class="ifoot">
        <span>${authorChip(i.author)}</span>
        <span>${escapeHtml(i.date||"")}</span>
      </div>
    </article>`;
  }).join("") || `<div class="empty">아직 아이디어가 없어요.</div>`;

  grid.querySelectorAll(".idea").forEach(el => {
    const id = el.dataset.iid;
    el.querySelector('[data-act="edit-idea"]').addEventListener("click", () => openIdeaModal(id));
    el.querySelector('[data-act="delete-idea"]').addEventListener("click", () => deleteIdea(id));
  });
}

function openIdeaModal(id){
  $("idea-edit-id").value = id || "";
  $("idea-error").textContent = "";
  if (id){
    const i = STATE.ideas.find(x => x.id === id);
    $("idea-modal-title").textContent = "아이디어 편집";
    $("idea-cat-input").value = i.category || "";
    $("idea-status").value = i.status || "논의중";
    $("idea-title-input").value = i.title || "";
    $("idea-content-input").value = i.content || "";
    $("idea-author").value = i.author || "";
  } else {
    $("idea-modal-title").textContent = "새 아이디어";
    $("idea-cat-input").value = "";
    $("idea-status").value = "논의중";
    $("idea-title-input").value = "";
    $("idea-content-input").value = "";
    $("idea-author").value = STATE.team[0]?.id || "";
  }
  $("idea-modal").showModal();
}

async function saveIdeaFromModal(){
  const editId = $("idea-edit-id").value;
  const title = $("idea-title-input").value.trim();
  if (!title){ $("idea-error").textContent = "제목은 필수."; return; }
  const data = {
    title,
    category: $("idea-cat-input").value.trim(),
    status: $("idea-status").value,
    content: $("idea-content-input").value,
    author: $("idea-author").value || undefined,
    date: new Date().toISOString().slice(0,10)
  };
  if (editId){
    const i = STATE.ideas.find(x => x.id === editId);
    Object.assign(i, data);
  } else {
    STATE.ideas = [{ id: uid("i"), ...data }, ...STATE.ideas];
  }
  try{
    await saveJSON("data/ideas.json", { ideas: STATE.ideas },
      `idea: ${editId ? "edit" : "add"} "${title}"`);
    $("idea-modal").close();
    renderIdeas();
    renderOverview();
  }catch(e){
    $("idea-error").textContent = e.message;
  }
}

function deleteIdea(id){
  const i = STATE.ideas.find(x => x.id === id);
  if (!i) return;
  confirmThen(`"${i.title}" 아이디어를 삭제할까?`, async () => {
    STATE.ideas = STATE.ideas.filter(x => x.id !== id);
    await saveJSON("data/ideas.json", { ideas: STATE.ideas }, `idea: delete "${i.title}"`);
    renderIdeas();
    renderOverview();
  });
}

init();
