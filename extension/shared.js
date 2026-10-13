/* Fonctions communes à la page ChatGPT (content scripts), au popup et au service
   worker (importScripts). Pas de module ES ni de bundler : tout est exposé sur
   l'objet global AnkiShared, chargé AVANT les autres fichiers.

   Mise en forme des cartes : un sous-ensemble volontairement réduit de Markdown.
     **gras**  *italique*  `code`  ^exposant^  ~indice~
     lignes « - … » (liste à puces) et « 1. … » (liste numérotée), retours à la ligne.
   Rien d'autre : ni lien, ni image, ni HTML brut. Le texte est TOUJOURS échappé
   avant conversion, et l'aperçu de la fenêtre de vérification est construit en
   DOM (createElement / textContent), jamais à partir d’une chaîne HTML.
   Les marqueurs de texte à trous {{c1::…}} et {{c1::…::indice}} sont des blocs
   atomiques : une mise en forme ne peut ni les couper, ni les traverser. */
(function (root) {
  'use strict';

  /* --- Texte et paquets ---------------------------------------------------- */
  // Comparaison insensible à la casse ET aux accents, sur le chemin complet.
  // Les ligatures (œ, æ) sont dépliées : « coeur » doit trouver « cœur ».
  const normText = s => String(s ?? '').replace(/œ/gi, 'oe').replace(/æ/gi, 'ae')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  // AnkiConnect renvoie « Parent::Enfant ». On n'affiche qu'un libellé lisible ;
  // la valeur transmise reste EXACTEMENT le nom complet du paquet.
  const deckLabel = name => String(name ?? '').split('::').map(s => s.trim()).filter(Boolean).join(' › ');

  /* Nom de paquet saisi dans la fenêtre de vérification. « › » (le séparateur
     affiché) est accepté comme « :: ». Chaque niveau est nettoyé de ses espaces
     de bord. Refusés : nom vide, niveau vide (« A:: »), plus de 150 caractères,
     guillemets (ils casseraient la recherche Anki deck:"…"). */
  const MAX_DECK_NAME = 150;
  function validateDeckName(raw) {
    const parts = String(raw ?? '').replace(/\s*›\s*/g, '::').split('::').map(s => s.replace(/\s+/g, ' ').trim());
    const name = parts.join('::');
    if (!name.replace(/:/g, '').trim()) return {ok: false, name: '', error: 'Le nom du paquet est vide.'};
    if (parts.some(p => !p)) return {ok: false, name, error: 'Un niveau du nom est vide (« :: » en trop ?).'};
    if (name.length > MAX_DECK_NAME) return {ok: false, name, error: `Nom trop long (${name.length} caractères, ${MAX_DECK_NAME} au maximum).`};
    if (/["“”«»]/.test(name)) return {ok: false, name, error: 'Le nom ne doit pas contenir de guillemets.'};
    if (/[\u0000-\u001f\u007f]/.test(name)) return {ok: false, name, error: 'Le nom contient un caractère invisible non autorisé.'};
    return {ok: true, name, error: ''};
  }
  // Anki ignore la casse des noms de paquet : « cours » et « Cours » sont le même.
  const sameDeck = (a, b) => String(a ?? '').toLocaleLowerCase() === String(b ?? '').toLocaleLowerCase();

  /* Tags Anki : pas d'espace. On garde lettres (y compris œ, æ, grec…), chiffres,
     « _ », « - » et la hiérarchie « Parent::Enfant » utilisée par beaucoup de
     paquets partagés. Un « : » isolé ou en bord de tag est retiré. */
  function normalizeTag(s) {
    return String(s ?? '').trim().replace(/\s+/g, '_')
      .replace(/[^\p{L}\p{N}_\-:]/gu, '')
      .replace(/:{3,}/g, '::').replace(/(^|[^:]):(?!:)/g, '$1').replace(/^:+|:+$/g, '')
      .slice(0, 100);
  }

  /* --- HTML ---------------------------------------------------------------- */
  // Même jeu d'échappement que les versions précédentes : un texte sans mise en
  // forme produit exactement le même champ Anki (doublons toujours reconnus).
  function escapeHtml(text) {
    return String(text ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  }
  /* Anki range du HTML dans les champs. Pour comparer deux contenus on retire les
     balises (fin de bloc ou début de liste = retour à la ligne) et on décode les
     entités usuelles. */
  function htmlToText(html) {
    return String(html ?? '')
      .replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(?:div|p|li|tr)>/gi, '\n').replace(/<(?:ul|ol)\b[^>]*>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, '&');
  }

  /* --- Mise en forme : analyse ------------------------------------------- */
  // Texte à trous commençant à la position i : {{cN::contenu}} ou {{cN::contenu::indice}}.
  // Les trous imbriqués sont suivis (profondeur). Sans fermeture : null (texte brut).
  const CLOZE_START = /\{\{c(\d+)::/y;
  function clozeAt(s, i) {
    if (s[i] !== '{') return null;
    CLOZE_START.lastIndex = i;
    const m = CLOZE_START.exec(s);
    if (!m) return null;
    const start = i + m[0].length;
    let depth = 0, hintAt = -1;
    for (let j = start; j < s.length; j++) {
      if (s.startsWith('{{', j)) { depth++; j++; continue; }
      if (s.startsWith('}}', j)) {
        if (depth === 0) {
          const content = s.slice(start, hintAt < 0 ? j : hintAt);
          const hint = hintAt < 0 ? null : s.slice(hintAt + 2, j);
          return {n: m[1], prefix: m[0], content, hint, end: j + 2};
        }
        depth--; j++; continue;
      }
      if (depth === 0 && hintAt < 0 && s.startsWith('::', j)) { hintAt = j; j++; }
    }
    return null;
  }
  // Fin d'un bloc de code `…` ouvert en i, ou -1.
  function codeEnd(s, i) {
    if (s[i] !== '`') return -1;
    const j = s.indexOf('`', i + 1);
    return j > i + 1 ? j : -1;
  }
  const isSpace = ch => ch === undefined || /\s/.test(ch);
  /* Fermeture d'un délimiteur (« ** », « * », « ^ », « ~ ») à partir de `from`.
     Les textes à trous et les blocs de code sont sautés d'un bloc : une mise en
     forme ne peut jamais se fermer au milieu d'un {{c1::…}}. */
  function findClose(s, from, delim, {noSpace = false} = {}) {
    for (let j = from; j < s.length; j++) {
      const cz = clozeAt(s, j);
      if (cz) { j = cz.end - 1; continue; }
      const ce = codeEnd(s, j);
      if (ce >= 0) { j = ce; continue; }
      if (noSpace && /\s/.test(s[j])) return -1;
      if (!s.startsWith(delim, j)) continue;
      if (delim === '*' && (s[j + 1] === '*' || s[j - 1] === '*')) continue;
      if ((delim === '^' || delim === '~') && s[j + 1] === delim) continue;
      if (j === from || isSpace(s[j - 1])) continue;
      return j;
    }
    return -1;
  }
  // Ligne → nœuds : {t:'text'|'code', v} | {t:'b'|'i'|'sup'|'sub', c:[…]} | {t:'cloze', prefix, c, hint}
  function inline(s) {
    const out = [];
    let buf = '';
    const flush = () => { if (buf) { out.push({t: 'text', v: buf}); buf = ''; } };
    for (let i = 0; i < s.length;) {
      const cz = clozeAt(s, i);
      if (cz) {
        flush();
        out.push({t: 'cloze', prefix: cz.prefix, c: inline(cz.content), hint: cz.hint});
        i = cz.end; continue;
      }
      const ch = s[i];
      if (ch === '`') {
        const j = codeEnd(s, i);
        if (j >= 0) { flush(); out.push({t: 'code', v: s.slice(i + 1, j)}); i = j + 1; continue; }
      } else if (ch === '*' && s[i + 1] === '*' && !isSpace(s[i + 2])) {
        const j = findClose(s, i + 2, '**');
        if (j >= 0) { flush(); out.push({t: 'b', c: inline(s.slice(i + 2, j))}); i = j + 2; continue; }
      } else if (ch === '*' && s[i + 1] !== '*' && s[i - 1] !== '*' && !isSpace(s[i + 1])) {
        const j = findClose(s, i + 1, '*');
        if (j >= 0) { flush(); out.push({t: 'i', c: inline(s.slice(i + 1, j))}); i = j + 1; continue; }
      } else if ((ch === '^' || ch === '~') && s[i + 1] !== ch && s[i - 1] !== ch && !isSpace(s[i + 1])) {
        // Exposant / indice : sans espace, comme Na^+^, Ca^2+^ ou H~2~O.
        const j = findClose(s, i + 1, ch, {noSpace: true});
        if (j >= 0) { flush(); out.push({t: ch === '^' ? 'sup' : 'sub', c: inline(s.slice(i + 1, j))}); i = j + 1; continue; }
      }
      buf += ch; i++;
    }
    flush();
    return out;
  }
  /* Découpe en lignes LOGIQUES : un retour à la ligne situé dans un texte à trous
     ne coupe pas la ligne (sinon une liste pourrait couper le marqueur). */
  function logicalLines(s) {
    const lines = [];
    let cur = '';
    for (let i = 0; i < s.length;) {
      const cz = clozeAt(s, i);
      if (cz) { cur += s.slice(i, cz.end); i = cz.end; continue; }
      if (s[i] === '\n') { lines.push(cur); cur = ''; i++; continue; }
      cur += s[i]; i++;
    }
    lines.push(cur);
    return lines;
  }
  const UL = /^ {0,3}- +(\S.*)$/s;
  const OL = /^ {0,3}(\d{1,9})\. +(\S.*)$/s;
  // Texte → blocs : {t:'lines', lines:[nœuds…]} | {t:'ul'|'ol', start, items:[nœuds…]}
  function parse(text) {
    const blocks = [];
    for (const line of logicalLines(String(text ?? ''))) {
      const ul = line.match(UL), ol = ul ? null : line.match(OL);
      const kind = ul ? 'ul' : ol ? 'ol' : 'lines';
      let last = blocks[blocks.length - 1];
      if (!last || last.t !== kind) {
        last = kind === 'lines' ? {t: 'lines', lines: []} : {t: kind, start: ol ? Number(ol[1]) : 1, items: []};
        blocks.push(last);
      }
      if (kind === 'lines') last.lines.push(inline(line));
      else last.items.push(inline(ul ? ul[1] : ol[2]));
    }
    // Les lignes vides collées à une liste ne font qu'ajouter un saut de ligne parasite.
    blocks.forEach((b, k) => {
      if (b.t !== 'lines') return;
      if (blocks[k - 1] && blocks[k - 1].t !== 'lines') while (b.lines.length && !b.lines[0].length) b.lines.shift();
      if (blocks[k + 1] && blocks[k + 1].t !== 'lines') while (b.lines.length && !b.lines[b.lines.length - 1].length) b.lines.pop();
    });
    return blocks.filter(b => b.t !== 'lines' || b.lines.length);
  }

  /* --- Mise en forme : rendus -------------------------------------------- */
  const TAG = {b: 'b', i: 'i', sup: 'sup', sub: 'sub'};
  // Rendu HTML d'un texte DÉJÀ échappé : seules nos balises fixes sont ajoutées.
  function htmlNodes(nodes) {
    return nodes.map(n => {
      if (n.t === 'text') return n.v.replaceAll('\n', '<br>');
      if (n.t === 'code') return '<code>' + n.v + '</code>';
      if (n.t === 'cloze') return n.prefix + htmlNodes(n.c) + (n.hint === null ? '' : '::' + n.hint) + '}}';
      return `<${TAG[n.t]}>${htmlNodes(n.c)}</${TAG[n.t]}>`;
    }).join('');
  }
  /* Texte de carte → champ Anki. Échappement d'abord, conversion ensuite : aucun
     HTML venant de ChatGPT ne peut passer. Un texte sans mise en forme donne le
     même résultat qu'avant (échappement + <br>). */
  function toAnkiHtml(text) {
    return parse(escapeHtml(text)).map(b => {
      if (b.t === 'lines') return b.lines.map(htmlNodes).join('<br>');
      const open = b.t === 'ol' && b.start !== 1 ? `<ol start="${b.start}">` : `<${b.t}>`;
      return open + b.items.map(item => '<li>' + htmlNodes(item) + '</li>').join('') + `</${b.t}>`;
    }).join('');
  }
  // Texte sans mise en forme (marqueurs retirés, trous conservés) : sert aux comparaisons.
  function plainNodes(nodes) {
    return nodes.map(n => {
      if (n.t === 'text' || n.t === 'code') return n.v;
      if (n.t === 'cloze') return n.prefix + plainNodes(n.c) + (n.hint === null ? '' : '::' + n.hint) + '}}';
      return plainNodes(n.c);
    }).join('');
  }
  function stripMarkdown(text) {
    return parse(text).map(b => (b.t === 'lines' ? b.lines : b.items).map(plainNodes).join('\n')).join('\n');
  }
  // La carte contient-elle une mise en forme reconnue ?
  function hasFormatting(text) {
    const s = String(text ?? '');
    return toAnkiHtml(s) !== escapeHtml(s).replaceAll('\n', '<br>');
  }
  /* Aperçu construit en DOM sûr : createElement + nœuds texte uniquement. Un trou
     {{c1::…}} est montré comme une zone surlignée, son indice en clair. */
  function domNodes(doc, parent, nodes) {
    for (const n of nodes) {
      if (n.t === 'text') {
        n.v.split('\n').forEach((part, k) => {
          if (k) parent.append(doc.createElement('br'));
          if (part) parent.append(doc.createTextNode(part));
        });
      } else if (n.t === 'code') {
        const code = doc.createElement('code');
        code.textContent = n.v;
        parent.append(code);
      } else if (n.t === 'cloze') {
        const span = doc.createElement('span');
        span.className = 'ankibridge-cloze';
        domNodes(doc, span, n.c);
        if (n.hint !== null) {
          const hint = doc.createElement('span');
          hint.className = 'ankibridge-clozehint';
          hint.textContent = ` (indice : ${n.hint})`;
          span.append(hint);
        }
        parent.append(span);
      } else {
        const el = doc.createElement(TAG[n.t]);
        domNodes(doc, el, n.c);
        parent.append(el);
      }
    }
  }
  function renderInto(target, text, doc) {
    target.replaceChildren();
    parse(text).forEach(b => {
      if (b.t === 'lines') {
        b.lines.forEach((line, k) => {
          if (k) target.append(doc.createElement('br'));
          domNodes(doc, target, line);
        });
        return;
      }
      const list = doc.createElement(b.t);
      if (b.t === 'ol' && b.start !== 1) list.setAttribute('start', String(b.start));
      for (const item of b.items) {
        const li = doc.createElement('li');
        domNodes(doc, li, item);
        list.append(li);
      }
      target.append(list);
    });
    return target;
  }

  root.AnkiShared = Object.freeze({
    normText, deckLabel, validateDeckName, sameDeck, normalizeTag, MAX_DECK_NAME,
    escapeHtml, htmlToText,
    toAnkiHtml, stripMarkdown, hasFormatting, renderInto, parseFormatting: parse
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
