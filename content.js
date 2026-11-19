/*
 * Stock リアクション追加（ありがとう・対応済み）
 *
 * Stock のリアクションはサーバー側で種類が固定されているため、
 * この拡張機能は「専用の小さなメッセージ」を送ることでリアクションを表現する。
 *
 *  - 送信するメッセージ: 「🙏 ありがとう\n> 〇〇さん「元メッセージ…」」
 *    1行目の末尾に、対象メッセージのIDを不可視文字（ゼロ幅文字）で埋め込む。
 *  - 拡張機能を入れている人: 専用メッセージは非表示になり、
 *    元メッセージの下に「🙏 ありがとう 2」のようなバッジとして表示される。
 *  - 入れていない人: 普通のメッセージとしてそのまま読める。
 */
(() => {
  'use strict';
  if (window.__stockReactionsPlus) return;
  window.__stockReactionsPlus = true;

  const TYPES = {
    thanks: { label: 'ありがとう', emoji: '🙏' },
    done: { label: '対応済み', emoji: '✅' },
  };
  const TYPE_ORDER = ['thanks', 'done'];
  const PREFIX = 'srx1';

  // ---------- 不可視タグ（対象メッセージIDの埋め込み） ----------
  const ZW0 = '​';
  const ZW1 = '‌';
  const ZWSEP = '⁣';

  function encodeTag(type, targetId) {
    const s = `${PREFIX}:${type}:${targetId}`;
    const bits = [...s].map((c) => c.charCodeAt(0).toString(2).padStart(8, '0')).join('');
    return ZWSEP + bits.replace(/0/g, ZW0).replace(/1/g, ZW1) + ZWSEP;
  }

  // 予備: 不可視文字が消された場合に備え、見える形式 [srx:done:123] も読めるようにしておく
  const VISIBLE_TAG_RE = /\[srx:(thanks|done):(\d+)\]/;

  function decodeTag(text) {
    if (!text) return null;
    const m = text.match(/⁣([​‌]+)⁣/);
    if (m) {
      const bits = m[1].replace(/​/g, '0').replace(/‌/g, '1');
      let s = '';
      for (let i = 0; i + 8 <= bits.length; i += 8) s += String.fromCharCode(parseInt(bits.slice(i, i + 8), 2));
      const [prefix, type, id] = s.split(':');
      if (prefix === PREFIX && TYPES[type] && /^\d+$/.test(id || '')) return { type, targetId: id };
    }
    const v = text.match(VISIBLE_TAG_RE);
    if (v) return { type: v[1], targetId: v[2] };
    return null;
  }

  // ---------- Stock の画面から情報を読む ----------
  function fiberPropsWith(el, key) {
    const fk = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    let f = fk ? el[fk] : null;
    for (let i = 0; i < 12 && f; i++, f = f.return) {
      const p = f.memoizedProps;
      if (p && typeof p === 'object' && key in p) return p;
    }
    return null;
  }

  function chatMeta(item) {
    try {
      const p = fiberPropsWith(item, 'chat');
      if (!p) return {};
      return { userId: p.chat && p.chat.userId, meId: p.me && p.me.id, poster: p.poster };
    } catch (_) {
      return {};
    }
  }

  function posterName(item) {
    const el = item.querySelector('[class^="chatListItem__topBox__name"]');
    const name = el && el.textContent.trim();
    if (name) return name;
    const { poster } = chatMeta(item);
    if (poster) return poster.nickname || [poster.lastname, poster.firstname].filter(Boolean).join('') || '';
    return '';
  }

  function messageText(item) {
    const el = item.querySelector('.chatListItem__message');
    return el ? el.textContent : '';
  }

  function snippetOf(item) {
    const line = messageText(item)
      .replace(/[​‌⁣]/g, '')
      .split('\n')
      .map((s) => s.trim())
      .find(Boolean) || '';
    const s = line.replace(/@/g, '＠');
    return s.length > 30 ? s.slice(0, 30) + '…' : s;
  }

  function messageArea(item) {
    return item.querySelector('.chatListItem__messageArea');
  }

  // ---------- 送信 ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;

  function setTextareaValue(ta, v) {
    valueSetter.call(ta, v);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function findComposer(item) {
    for (let el = item.parentElement; el && el !== document.body; el = el.parentElement) {
      const ta = el.querySelector('textarea.chatroom__messageTextArea');
      const btn = el.querySelector('.chatroom__toolBar__sendBtn');
      if (ta && btn) return { ta, btn };
    }
    return null;
  }

  let sending = false;
  async function sendMessage(item, text) {
    if (sending) return false;
    const c = findComposer(item);
    if (!c) {
      toast('送信欄が見つかりませんでした。メッセージ欄を開いてからお試しください。');
      return false;
    }
    sending = true;
    try {
      const draft = c.ta.value;
      setTextareaValue(c.ta, text);
      await sleep(80);
      c.btn.click();
      await sleep(700);
      if (draft && !c.ta.value) setTextareaValue(c.ta, draft); // 書きかけの内容を戻す
      return true;
    } finally {
      sending = false;
    }
  }

  // ---------- 状態の集計と描画 ----------
  /** targetId -> { type -> Map(userKey -> { name, mine, markerIds[] }) } */
  let state = new Map();
  const revealed = new Set(); // 一時的に表示している専用メッセージのID

  function collect() {
    const next = new Map();
    for (const item of document.querySelectorAll('.chatListItem[data-chat-id]')) {
      const tag = decodeTag(messageText(item));
      if (!tag) {
        item.classList.remove('srx-marker');
        continue;
      }
      item.classList.add('srx-marker');
      item.classList.toggle('srx-revealed', revealed.has(item.dataset.chatId));
      const meta = chatMeta(item);
      const name = posterName(item);
      const mine = meta.userId != null && meta.userId === meta.meId;
      const key = meta.userId != null ? `u${meta.userId}` : `n${name}`;
      if (!next.has(tag.targetId)) next.set(tag.targetId, {});
      const byType = next.get(tag.targetId);
      if (!byType[tag.type]) byType[tag.type] = new Map();
      const users = byType[tag.type];
      const u = users.get(key) || { name, mine, markerIds: [] };
      u.markerIds.push(item.dataset.chatId);
      users.set(key, u);
    }
    state = next;
  }

  function ensureButtons(item) {
    const box = item.querySelector('.chatListItemToolBox');
    if (!box || box.querySelector('.srx-btn')) return;
    // 「了解しました」の右に入れる。Stock Plus の「対応します！」に置き換わっている場合や、
    // 了解済み（「了解解除」「対応解除」）の場合も同じ位置に入れる。
    const ACK_LABELS = ['了解しました', '了解解除', '対応します！', '対応解除'];
    const ack = [...box.children].find((b) => b.tagName === 'BUTTON' && ACK_LABELS.includes(b.textContent.trim()));
    if (!ack) return; // 了解ボタンが出ないメッセージ（自分の投稿・システム通知など）には付けない
    let ref = ack;
    for (const type of TYPE_ORDER) {
      const t = TYPES[type];
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'srx-btn';
      b.dataset.srxType = type;
      b.innerHTML = `<span class="srx-emoji">${t.emoji}</span><span>${t.label}</span>`;
      ref.after(b);
      ref = b;
    }
  }

  function renderBadges(item) {
    const area = messageArea(item);
    if (!area) return;
    const byType = state.get(item.dataset.chatId) || {};
    const chips = TYPE_ORDER.filter((t) => byType[t] && byType[t].size).map((t) => {
      const users = [...byType[t].values()];
      return { type: t, count: users.length, mine: users.some((u) => u.mine), names: users.map((u) => u.name).filter(Boolean) };
    });
    const sig = JSON.stringify(chips);
    let box = area.querySelector(':scope > .srx-badges');
    if (!chips.length) {
      if (box) box.remove();
      return;
    }
    if (box && box.dataset.sig === sig) return;
    if (!box) {
      box = document.createElement('div');
      box.className = 'srx-badges';
      area.appendChild(box);
    }
    box.dataset.sig = sig;
    box.textContent = '';
    for (const c of chips) {
      const t = TYPES[c.type];
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'srx-chip' + (c.mine ? ' srx-chip--mine' : '');
      chip.dataset.srxType = c.type;
      chip.title = `${c.names.join('、')} が${t.label}`;
      chip.innerHTML = `<span class="srx-emoji">${t.emoji}</span><span class="srx-chip__label"></span><span class="srx-chip__count">${c.count}</span>`;
      chip.querySelector('.srx-chip__label').textContent = t.label;
      box.appendChild(chip);
    }
  }

  function refresh() {
    collect();
    for (const item of document.querySelectorAll('.chatListItem[data-chat-id]')) {
      if (item.classList.contains('srx-marker')) continue;
      ensureButtons(item);
      renderBadges(item);
    }
  }

  // ---------- 操作 ----------
  function myReaction(targetId, type) {
    const users = (state.get(targetId) || {})[type];
    if (!users) return null;
    return [...users.values()].find((u) => u.mine) || null;
  }

  async function react(item, type) {
    const id = item.dataset.chatId;
    const t = TYPES[type];
    if (myReaction(id, type)) {
      undoMine(item, type);
      return;
    }
    const name = posterName(item);
    const quote = name ? `> ${name}さん「${snippetOf(item)}」` : `> 「${snippetOf(item)}」`;
    const text = `${t.emoji} ${t.label}${encodeTag(type, id)}\n${quote}`;
    if (await sendMessage(item, text)) toast(`${t.emoji} ${t.label} を送りました`);
  }

  // 自分のリアクションを取り消す: 専用メッセージに対して Stock 標準の「削除」を押す
  // （Stock の「削除してもよろしいですか？」確認が出るので、OK で取り消し完了）
  function undoMine(item, type) {
    const mine = myReaction(item.dataset.chatId, type);
    if (!mine) return;
    const marker = document.querySelector(`.chatListItem[data-chat-id="${mine.markerIds[0]}"]`);
    const del = marker && [...marker.querySelectorAll('.chatListItemToolBox button')].find((b) => b.textContent.trim() === '削除');
    if (del) {
      del.click();
      return;
    }
    revealMine(item, type);
  }

  function revealMine(item, type) {
    const mine = myReaction(item.dataset.chatId, type);
    if (!mine) return;
    for (const mid of mine.markerIds) revealed.add(mid);
    refresh();
    const el = document.querySelector(`.chatListItem[data-chat-id="${mine.markerIds[0]}"]`);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    toast(`「${TYPES[type].label}」済みです。取り消す場合は、表示したメッセージ（点線枠）をStockの通常の操作で削除してください。`, 6000);
    setTimeout(() => {
      for (const mid of mine.markerIds) revealed.delete(mid);
      refresh();
    }, 30000);
  }

  document.addEventListener(
    'click',
    (e) => {
      const el = e.target.closest && e.target.closest('.srx-btn, .srx-chip');
      if (!el) return;
      const item = el.closest('.chatListItem[data-chat-id]');
      if (!item) return;
      e.preventDefault();
      e.stopPropagation();
      react(item, el.dataset.srxType);
    },
    true
  );

  // ---------- トースト ----------
  let toastTimer;
  function toast(msg, ms = 2500) {
    let el = document.getElementById('srx-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'srx-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('srx-toast--show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('srx-toast--show'), ms);
  }

  // ---------- 監視 ----------
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      try {
        refresh();
      } catch (err) {
        console.warn('[Stock Reactions+]', err);
      }
    }, 120);
  }
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
  schedule();
})();
