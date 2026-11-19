/*
 * Stock Reactions（ありがとう・完了しました）
 *
 * Stock のリアクションはサーバー側で種類が固定されているため、
 * この拡張機能は「専用の小さなメッセージ」を送ることでリアクションを表現する。
 *
 *  - 送信するメッセージ: 「🙏 ありがとう\n> 〇〇さん「元メッセージ…」」
 *    1行目の末尾に、対象メッセージのIDを不可視文字（ゼロ幅文字）で埋め込む。
 *  - 拡張機能を入れている人: 専用メッセージは非表示になり、
 *    元メッセージの下に「了解しました」と同じ形式（「2人がありがとう」）で表示される。
 *  - 入れていない人: 普通のメッセージとしてそのまま読める。
 */
(() => {
  'use strict';
  if (window.__stockReactionsPlus) return;
  window.__stockReactionsPlus = true;

  // type は送信済みメッセージに埋め込まれるため変更しない（done = 完了しました。旧表記「対応済み」）
  const TYPES = {
    thanks: { label: 'ありがとう', undo: 'ありがとう解除', emoji: '🙏' },
    done: { label: '完了しました', undo: '完了解除', emoji: '✅' },
  };
  const TYPE_ORDER = ['thanks', 'done'];
  const PREFIX = 'srx1';
  const ACK_LABELS = ['了解しました', '了解解除', '対応します！', '対応解除'];

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
      return {
        userId: p.chat && p.chat.userId,
        meId: p.me && p.me.id,
        poster: p.poster,
        members: Array.isArray(p.members) ? p.members : null,
      };
    } catch (_) {
      return {};
    }
  }

  function userName(u) {
    if (!u) return '';
    return u.name || [u.lastname, u.firstname].filter(Boolean).join(' ') || '';
  }

  function posterName(item) {
    const el = item.querySelector('[class^="chatListItem__topBox__name"]');
    const name = el && el.textContent.trim();
    if (name) return name;
    return userName(chatMeta(item).poster);
  }

  function messageText(item) {
    const el = item.querySelector('.chatListItem__message');
    return el ? el.textContent : '';
  }

  function snippetOf(item) {
    const line =
      messageText(item)
        .replace(/[​‌⁣]/g, '')
        .split('\n')
        .map((s) => s.trim())
        .find(Boolean) || '';
    const s = line.replace(/@/g, '＠');
    return s.length > 30 ? s.slice(0, 30) + '…' : s;
  }

  const itemById = (id) => document.querySelector(`.chatListItem[data-chat-id="${id}"]`);

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

  let busy = false;
  async function sendMessage(item, text) {
    const c = findComposer(item);
    if (!c) {
      toast('送信欄が見つかりませんでした。メッセージ欄を開いてからお試しください。');
      return false;
    }
    const draft = c.ta.value;
    setTextareaValue(c.ta, text);
    await sleep(80);
    c.btn.click();
    await sleep(700);
    if (draft && !c.ta.value) setTextareaValue(c.ta, draft); // 書きかけの内容を戻す
    return true;
  }

  // 専用メッセージを、Stock の「削除」→ 確認ダイアログの OK まで自動で押して消す（確認は表示しない）
  async function deleteMarker(markerId) {
    const marker = itemById(markerId);
    const del = marker && [...marker.querySelectorAll('.chatListItemToolBox button')].find((b) => b.textContent.trim() === '削除');
    if (!del) return false;
    document.body.classList.add('srx-silent');
    try {
      del.click();
      for (let i = 0; i < 30; i++) {
        await sleep(50);
        const ok = [...document.querySelectorAll('.modal button')].find(
          (b) => b.textContent.trim() === 'OK' && /削除してもよろしいですか/.test(b.closest('.modal').textContent)
        );
        if (ok) {
          ok.click();
          await sleep(300);
          return true;
        }
      }
      return false;
    } finally {
      document.body.classList.remove('srx-silent');
    }
  }

  // ---------- 状態の集計 ----------
  /** targetId -> { type -> Map(userKey -> { userId, name, mine, markerIds[] }) } */
  let state = new Map();

  function collect() {
    const next = new Map();
    for (const item of document.querySelectorAll('.chatListItem[data-chat-id]')) {
      const tag = decodeTag(messageText(item));
      if (!tag) {
        item.classList.remove('srx-marker');
        continue;
      }
      item.classList.add('srx-marker');
      const meta = chatMeta(item);
      const name = posterName(item);
      const mine = meta.userId != null && meta.userId === meta.meId;
      const key = meta.userId != null ? `u${meta.userId}` : `n${name}`;
      if (!next.has(tag.targetId)) next.set(tag.targetId, {});
      const byType = next.get(tag.targetId);
      if (!byType[tag.type]) byType[tag.type] = new Map();
      const users = byType[tag.type];
      const u = users.get(key) || { userId: meta.userId, name, mine, markerIds: [] };
      u.markerIds.push(item.dataset.chatId);
      users.set(key, u);
    }
    state = next;
  }

  function reactorsOf(targetId, type) {
    const users = (state.get(targetId) || {})[type];
    return users ? [...users.values()] : [];
  }

  const myReaction = (targetId, type) => reactorsOf(targetId, type).find((u) => u.mine) || null;

  // ---------- 描画 ----------
  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  // ホバー時の操作ボタン（「了解しました」の右）
  function ensureButtons(item) {
    const box = item.querySelector('.chatListItemToolBox');
    if (!box) return;
    let btns = box.querySelectorAll('.srx-btn');
    if (!btns.length) {
      const ack = [...box.children].find((b) => b.tagName === 'BUTTON' && ACK_LABELS.includes(b.textContent.trim()));
      if (!ack) return; // 了解ボタンが出ないメッセージ（自分の投稿・システム通知など）には付けない
      let ref = ack;
      for (const type of TYPE_ORDER) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'srx-btn';
        b.dataset.srxType = type;
        b.dataset.srxAction = 'toggle';
        b.innerHTML = `<span class="srx-emoji">${TYPES[type].emoji}</span><span class="srx-btn__label"></span>`;
        ref.after(b);
        ref = b;
      }
      btns = box.querySelectorAll('.srx-btn');
    }
    for (const b of btns) {
      const t = TYPES[b.dataset.srxType];
      setText(b.querySelector('.srx-btn__label'), myReaction(item.dataset.chatId, b.dataset.srxType) ? t.undo : t.label);
    }
  }

  // メッセージ下の表示（「1人が了解しました」と同じ形式）
  function renderReactions(item) {
    const bottom = item.querySelector('.chatListItemBottom');
    if (!bottom) return;
    const id = item.dataset.chatId;
    const rows = TYPE_ORDER.map((type) => ({ type, users: reactorsOf(id, type) })).filter((r) => r.users.length);
    const sig = JSON.stringify(rows.map((r) => [r.type, r.users.length, r.users.some((u) => u.mine)]));
    const existing = bottom.querySelectorAll(':scope > .srx-reactions');
    if (bottom.dataset.srxSig === sig && existing.length === rows.length) return;
    bottom.dataset.srxSig = sig;
    existing.forEach((e) => e.remove());
    const before = bottom.querySelector(':scope > .chatListItemEmotionsContainer');
    for (const r of rows) {
      const t = TYPES[r.type];
      const reacted = r.users.some((u) => u.mine);
      const c = document.createElement('div');
      c.className = 'chatListItemReactionsContainer srx-reactions' + (reacted ? ' reacted' : '');
      c.dataset.srxType = r.type;
      c.innerHTML =
        `<button type="button" class="chatListItemReactionsContainer__button" data-srx-type="${r.type}" data-srx-action="toggle-or-list">` +
        `<span class="srx-emoji">${t.emoji}</span></button>` +
        `<a class="chatListItemReactionsContainer__link" data-srx-type="${r.type}" data-srx-action="list"></a>`;
      c.querySelector('a').textContent = `${r.users.length}人が${t.label}`;
      bottom.insertBefore(c, before);
    }
  }

  function refresh() {
    collect();
    for (const item of document.querySelectorAll('.chatListItem[data-chat-id]')) {
      if (item.classList.contains('srx-marker')) continue;
      ensureButtons(item);
      renderReactions(item);
    }
    if (openPopover && !document.body.contains(openPopover.anchor)) closePopover();
  }

  // ---------- 押した人の一覧（Stock の「了解しました」と同じポップアップ） ----------
  let openPopover = null;

  function closePopover() {
    if (openPopover) openPopover.el.remove();
    openPopover = null;
  }

  function showPopover(item, type, anchor) {
    closePopover();
    const t = TYPES[type];
    const reactors = reactorsOf(item.dataset.chatId, type);
    const reactedIds = new Set(reactors.map((u) => u.userId));
    const { members } = chatMeta(item);
    let list;
    if (members && members.length) {
      const reacted = members.filter((m) => reactedIds.has(m.id));
      const others = members.filter((m) => !reactedIds.has(m.id));
      list = [...reacted, ...others].map((m) => ({ name: userName(m), avatar: m.middleAvatarUrl || m.avatarUrl, checked: reactedIds.has(m.id) }));
      // メンバー一覧に居ない人（退出済みなど）も表示する
      for (const u of reactors) if (!members.some((m) => m.id === u.userId)) list.unshift({ name: u.name, checked: true });
    } else {
      list = reactors.map((u) => ({ name: u.name, checked: true }));
    }

    const el = document.createElement('div');
    el.className = 'fade customPopoverMenu show popover bs-popover-top srx-popover';
    el.setAttribute('role', 'tooltip');
    el.innerHTML =
      '<div class="chatMembersPopover keepChatGroupsOpen">' +
      '<button type="button" class="chatMembersPopover__closeBtn"><i class="closeIcon"></i></button>' +
      '<p class="chatListItemReactionsPopoverHeader"><strong></strong></p>' +
      '<ul class="chatMembersPopover__list"></ul></div>';
    const header = el.querySelector('.chatListItemReactionsPopoverHeader');
    header.querySelector('strong').textContent = `${reactors.length}人`;
    header.append(`が${t.label}`);
    const ul = el.querySelector('ul');
    for (const m of list) {
      const li = document.createElement('li');
      li.className = 'chatMembersPopoverListItem';
      li.innerHTML =
        '<div class="chatMembersPopoverListItem__avatar"><div class="avatarBox"></div></div><p class="chatMembersPopoverListItem__name"></p>' +
        (m.checked ? '<div class="chatMembersPopoverListItem__chk"><span class="srx-check">✓</span></div>' : '');
      if (m.avatar) li.querySelector('.avatarBox').style.backgroundImage = `url("${m.avatar.replace(/"/g, '%22')}")`;
      li.querySelector('.chatMembersPopoverListItem__name').textContent = m.name;
      ul.appendChild(li);
    }
    el.querySelector('.chatMembersPopover__closeBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      closePopover();
    });
    el.style.visibility = 'hidden';
    document.body.appendChild(el);
    const a = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = Math.min(a.left, window.innerWidth - w - 8);
    left = Math.max(8, left);
    let top = a.top - h - 8;
    if (top < 8) top = a.bottom + 8;
    el.style.left = `${left + window.scrollX}px`;
    el.style.top = `${top + window.scrollY}px`;
    el.style.visibility = '';
    openPopover = { el, anchor };
  }

  // ---------- 操作 ----------
  async function addReaction(item, type) {
    const t = TYPES[type];
    const name = posterName(item);
    const quote = name ? `> ${name}さん「${snippetOf(item)}」` : `> 「${snippetOf(item)}」`;
    await sendMessage(item, `${t.emoji} ${t.label}${encodeTag(type, item.dataset.chatId)}\n${quote}`);
  }

  async function removeReaction(item, type) {
    const mine = myReaction(item.dataset.chatId, type);
    if (!mine) return;
    for (const mid of mine.markerIds) {
      if (!(await deleteMarker(mid))) {
        toast('取り消せませんでした。ページを再読み込みしてからお試しください。');
        return;
      }
    }
  }

  async function toggle(item, type) {
    if (busy) return;
    busy = true;
    try {
      if (myReaction(item.dataset.chatId, type)) await removeReaction(item, type);
      else await addReaction(item, type);
    } finally {
      busy = false;
      schedule();
    }
  }

  document.addEventListener(
    'click',
    (e) => {
      const el = e.target.closest && e.target.closest('[data-srx-action]');
      if (!el) {
        if (openPopover && !openPopover.el.contains(e.target)) closePopover();
        return;
      }
      const item = el.closest('.chatListItem[data-chat-id]');
      if (!item) return;
      e.preventDefault();
      e.stopPropagation();
      const type = el.dataset.srxType;
      const action = el.dataset.srxAction;
      if (action === 'list') {
        showPopover(item, type, el);
      } else if (action === 'toggle-or-list') {
        // Stock と同じ: 自分の投稿なら一覧、そうでなければ付ける／外す
        const meta = chatMeta(item);
        if (meta.userId != null && meta.userId === meta.meId) showPopover(item, type, el.nextElementSibling || el);
        else toggle(item, type);
      } else {
        toggle(item, type);
      }
    },
    true
  );

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePopover();
  });
  window.addEventListener('resize', closePopover);
  document.addEventListener(
    'scroll',
    (e) => {
      if (openPopover && !(e.target instanceof Node && openPopover.el.contains(e.target))) closePopover();
    },
    true
  );

  // ---------- トースト ----------
  let toastTimer;
  function toast(msg, ms = 3000) {
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
        console.warn('[Stock Reactions]', err);
      }
    }, 120);
  }
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
  schedule();
})();
