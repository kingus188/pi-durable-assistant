const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem('piDemoToken') || '';
let busy = false;
let polls = 0;
let pollTimer;
$('token').value = token;

function feedback(message) { $('feedback').textContent = message; }
function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className || '';
  node.textContent = text || '';
  return node;
}
async function api(path, options = {}) {
  if (!token) throw new Error('请先输入 DEMO_TOKEN');
  const response = await fetch(path, {
    ...options,
    headers: { Authorization: 'Bearer ' + token, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status);
  return data;
}
function render(state) {
  const messages = $('messages');
  messages.replaceChildren();
  for (const msg of state.messages || []) {
    const bubble = element('div', 'bubble ' + (msg.role === 'user' ? 'user' : ''), msg.text);
    bubble.prepend(element('span', 'label', msg.role === 'user' ? '你' : 'Pi Durable · faux'));
    messages.append(bubble);
  }
  if (!messages.children.length) messages.append(element('div', 'muted', '尚无聊天记录。'));
  messages.scrollTop = messages.scrollHeight;
  const pending = state.pending || [];
  $('pending').textContent = pending.length ? '未完成任务：' + pending.length + '（后台执行中；无需保持网页打开）' : '当前没有未完成任务。';
  const reminders = $('reminders');
  reminders.replaceChildren();
  for (const item of state.reminders || []) {
    const when = new Date(item.dueAt).toLocaleString('zh-CN');
    const row = element('div', 'reminder', item.text + ' · ' + when);
    row.append(element('span', 'tag', item.status === 'fired' ? '已触发' : item.status === 'scheduled' ? '待触发' : '失败'));
    reminders.append(row);
  }
  if (!reminders.children.length) reminders.textContent = '暂无提醒。';
  // Avoid indefinite polling and unnecessary free-tier consumption.
  const scheduled = (state.reminders || []).some((item) => item.status === 'scheduled');
  if ((pending.length || scheduled) && polls < 35) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => refresh(true), 2500);
    polls += 1;
  } else if (polls >= 35) {
    $('pending').textContent += ' 自动刷新已停止，请手动刷新。';
  }
}
async function refresh(quiet = false) {
  try {
    const state = await api('/api/state');
    render(state);
    if (!quiet) feedback('已连接。状态来自 Cloudflare SQLite-backed Durable Object。');
  } catch (error) { feedback(error.message); }
}
$('connect').addEventListener('click', () => {
  token = $('token').value.trim();
  sessionStorage.setItem('piDemoToken', token);
  polls = 0;
  refresh();
});
$('refresh').addEventListener('click', () => { polls = 0; refresh(); });
$('send').addEventListener('click', async () => {
  if (busy) return;
  const text = $('prompt').value.trim() || '执行一次 12 秒的 Pi Durable 任务恢复演示';
  busy = true; $('send').disabled = true;
  try {
    const operationId = crypto.randomUUID();
    const result = await api('/api/chat', { method: 'POST', body: JSON.stringify({ text, operationId }) });
    $('prompt').value = '';
    polls = 0;
    feedback('已持久提交：' + result.operationId + '；刷新或关闭页面不会撤销任务。');
    await refresh(true);
  } catch (error) { feedback(error.message); }
  finally { busy = false; $('send').disabled = false; }
});
$('remind').addEventListener('click', async () => {
  const seconds = Number($('seconds').value);
  const text = $('reminder-text').value.trim() || '站起来活动一下';
  try {
    await api('/api/reminders', { method: 'POST', body: JSON.stringify({ text, seconds }) });
    $('reminder-text').value = '';
    feedback('定时提醒已保存。到期由 Cloudflare 自动唤醒。');
    await refresh(true);
  } catch (error) { feedback(error.message); }
});
if (token) refresh();
