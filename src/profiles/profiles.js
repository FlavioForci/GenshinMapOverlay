// Profil-Abfrage: wählen (Klick + Weiter, Doppelklick, Enter), umbenennen, hinzufügen, löschen
const api = window.profileApi;
const $ = (id) => document.getElementById(id);

let state = null;
let selected = null;
// Id im Umbenennen-Modus (mit getipptem Text) bzw. mit Lösch-Rückfrage
let editing = null;
let draft = null;
let confirming = null;

const tt = (key, params) => I18n.t(state.language, key, params);

const ICONS = {
  rename: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
  remove: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (tag === 'button') node.type = 'button';
  return node;
}

function iconButton(kind, title, onClick) {
  const button = el('button', `icon-btn ${kind}`);
  button.title = title;
  button.setAttribute('aria-label', title);
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[kind]}"/></svg>`;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function applyTexts() {
  document.documentElement.lang = I18n.resolve(state.language);
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = tt(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-title]')) node.title = tt(node.dataset.i18nTitle);
  for (const node of document.querySelectorAll('[data-i18n-aria]')) node.setAttribute('aria-label', tt(node.dataset.i18nAria));
}

function render() {
  applyTexts();
  if (!state.list.some((p) => p.id === selected)) selected = state.active;
  if (!state.list.some((p) => p.id === editing)) editing = null;
  if (!state.list.some((p) => p.id === confirming)) confirming = null;
  $('list').replaceChildren(...state.list.map(row));
  $('ask').checked = state.ask;
  const input = $('list').querySelector('input');
  if (input) {
    input.focus();
    input.select();
  }
  api.height(Math.ceil($('card').getBoundingClientRect().height));
}

function update(next) {
  if (!next) return;
  state = next;
  render();
}

// Nur Markierung umsetzen: neu aufbauen würde den Doppelklick verschlucken
function select(id) {
  selected = id;
  for (const node of $('list').children) node.classList.toggle('selected', node.dataset.id === id);
}

function row(p) {
  const li = el('li', 'row');
  li.dataset.id = p.id;
  li.classList.toggle('selected', p.id === selected);
  li.classList.toggle('current', p.id === state.active);

  if (confirming === p.id) {
    li.classList.add('confirm');
    const yes = el('button', 'small danger', tt('profile.yes'));
    yes.addEventListener('click', async () => {
      confirming = null;
      update(await api.remove(p.id));
    });
    const no = el('button', 'small', tt('profile.no'));
    no.addEventListener('click', () => {
      confirming = null;
      render();
    });
    li.append(el('span', 'confirm-text', tt('profile.removeAsk', { name: p.name })), yes, no);
    return li;
  }

  li.append(el('span', 'mark'));
  if (editing === p.id) {
    const input = el('input', 'name-input');
    input.type = 'text';
    input.maxLength = 40;
    input.spellcheck = false;
    input.value = draft ?? p.name;
    input.addEventListener('input', () => {
      draft = input.value;
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit(p.id, input.value);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        editing = null;
        draft = null;
        render();
      }
    });
    input.addEventListener('blur', () => commit(p.id, input.value));
    li.append(input);
  } else {
    const text = el('span', 'text');
    const count = p.count.toLocaleString(I18n.locale(state.language));
    text.append(el('span', 'name', p.name), el('span', 'count', tt('profile.count', { n: count })));
    li.append(text);
    li.append(iconButton('rename', tt('profile.rename'), () => {
      editing = p.id;
      draft = null;
      confirming = null;
      selected = p.id;
      render();
    }));
    if (state.list.length > 1) {
      li.append(iconButton('remove', tt('profile.remove'), () => {
        confirming = p.id;
        editing = null;
        render();
      }));
    }
  }
  li.addEventListener('click', () => {
    if (editing !== p.id) select(p.id);
  });
  li.addEventListener('dblclick', () => {
    if (editing !== p.id) api.choose(p.id);
  });
  return li;
}

async function commit(id, value) {
  if (editing !== id) return;
  editing = null;
  draft = null;
  update(await api.rename(id, value));
}

function move(step) {
  const ids = state.list.map((p) => p.id);
  const index = ids.indexOf(selected);
  select(ids[Math.min(ids.length - 1, Math.max(0, index + step))]);
}

$('add').addEventListener('click', async () => {
  const result = await api.add();
  if (!result) return;
  if (result.id) {
    selected = result.id;
    editing = result.id;
    draft = null;
    confirming = null;
  }
  update(result.state);
});

$('go').addEventListener('click', () => api.choose(selected));
$('close').addEventListener('click', () => api.close());
$('ask').addEventListener('change', (event) => api.ask(event.target.checked));

// Enter = Weiter, Esc = so lassen, Pfeile = Auswahl; nicht beim Tippen oder auf Knöpfen
document.addEventListener('keydown', (event) => {
  if (!state || editing || event.target.tagName === 'INPUT' && event.target.type === 'text') return;
  if (event.key === 'Escape') {
    if (confirming) {
      confirming = null;
      render();
    } else {
      api.close();
    }
  } else if (event.key === 'Enter' && !confirming && !event.target.closest('button')) {
    event.preventDefault();
    api.choose(selected);
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    move(event.key === 'ArrowDown' ? 1 : -1);
  }
});

api.onChange(update);
api.state().then((next) => {
  selected = next.active;
  update(next);
});
