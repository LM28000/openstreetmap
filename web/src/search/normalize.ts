/**
 * Normalisation et classement du texte, communs à toutes les sources.
 *
 * Tout est comparé sans accents, sans majuscules, avec tirets et apostrophes
 * traités comme des espaces (« Vélib' » = « velib », « Part-Dieu » = « part dieu »).
 * Un texte indexé est « rembourré » d'une espace de chaque côté : chercher un mot
 * entier, un début de mot ou un fragment devient alors un simple `includes`, sans
 * découper le texte à chaque frappe (c'est ce qui tient les 53 000 bornes sous 10 ms).
 */

/** Minuscules, sans accents ; tout ce qui n'est ni lettre ni chiffre devient une espace. */
export function fold(text: string): string {
  return text
    .replace(/œ/gi, 'oe')
    .replace(/æ/gi, 'ae')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Texte prêt à être indexé : normalisé et entouré d'espaces. */
export const pad = (text: string): string => ` ${fold(text)} `;

interface Token {
  /** Le mot tel que tapé (normalisé). */
  word: string;
  /** Formes à chercher dans un texte rembourré : mot entier, début de mot. */
  whole: string;
  start: string;
}

export interface Query {
  /** Ce que la personne a tapé. */
  raw: string;
  /** Texte normalisé. */
  text: string;
  tokens: Token[];
  /** Les mots collés (« afr 1234 » → « afr1234 »), pour les indicatifs tapés avec une espace. */
  glued: Token | null;
}

function token(word: string): Token {
  return { word, whole: ` ${word} `, start: ` ${word}` };
}

export function parseQuery(raw: string): Query {
  const text = fold(raw);
  const words = text ? text.split(' ') : [];
  return {
    raw,
    text,
    tokens: words.map(token),
    glued: words.length > 1 && words.length <= 3 ? token(words.join('')) : null,
  };
}

/**
 * Note de correspondance entre une requête et un texte rembourré, 0 s'il ne
 * correspond pas. Chaque mot doit être trouvé : mot entier (3), début de mot (2),
 * fragment (1), puis, si `fuzzy`, approchant à une faute près (0,6).
 * Le résultat est la moyenne des mots, entre 0,6 et 3.
 */
export function matchScore(padded: string, query: Query, fuzzy = false): number {
  let best = tokensScore(padded, query.tokens, fuzzy);
  if (query.glued && best < 3) best = Math.max(best, tokensScore(padded, [query.glued], false));
  return best;
}

function tokensScore(padded: string, tokens: readonly Token[], fuzzy: boolean): number {
  if (tokens.length === 0) return 0;
  let sum = 0;
  for (const t of tokens) {
    if (padded.includes(t.whole)) sum += 3;
    else if (padded.includes(t.start)) sum += 2;
    else if (t.word.length >= 3 && !/^\d+$/.test(t.word) && padded.includes(t.word)) sum += 1;
    else if (fuzzy && t.word.length >= 5 && !/\d/.test(t.word) && fuzzyIncludes(padded, t.word)) sum += 0.6;
    else return 0;
  }
  return sum / tokens.length;
}

/**
 * Classement final : la correspondance domine, puis un texte qui est exactement la
 * requête (ou qui commence par elle), puis la brièveté (« Lyon » avant « Lyon-Saint-Exupéry TGV »).
 */
export function rank(padded: string, query: Query, match: number): number {
  let score = match * 100;
  if (padded === ` ${query.text} `) score += 120;
  else if (padded.startsWith(` ${query.text}`)) score += 60;
  return score - padded.length * 0.3;
}

/** Vrai si un mot du texte est à une faute près (ou deux, pour un mot long) du mot cherché, ou de son début. */
function fuzzyIncludes(padded: string, word: string): boolean {
  const limit = word.length >= 8 ? 2 : 1;
  for (const candidate of padded.split(' ')) {
    if (!candidate || candidate[0] !== word[0]) continue; // une faute de frappe porte rarement sur la première lettre
    if (editDistance(candidate, word, limit) <= limit) return true;
    // un mot plus long peut commencer comme le mot tapé (frappe en cours)
    if (candidate.length > word.length && editDistance(candidate.slice(0, word.length), word, limit) <= limit) return true;
  }
  return false;
}

/** Distance de Damerau-Levenshtein (inversion de deux lettres = une faute), abandonnée au-delà de `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    const row: number[] = [];
    for (let j = 0; j <= b.length; j++) row.push(i === 0 ? j : j === 0 ? i : 0);
    rows.push(row);
  }
  for (let i = 1; i <= a.length; i++) {
    let rowMin = max + 1;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = d;
      rowMin = Math.min(rowMin, d);
    }
    if (rowMin > max) return max + 1;
  }
  return rows[a.length]![b.length]!;
}

/** Garde les `limit` meilleurs éléments d'un flux, sans trier le tout. */
export class TopK<T> {
  private readonly items: Array<{ score: number; item: T }> = [];
  constructor(private readonly limit: number) {}

  push(score: number, item: T): void {
    const { items } = this;
    if (items.length === this.limit && score <= items[items.length - 1]!.score) return;
    let i = items.length;
    while (i > 0 && items[i - 1]!.score < score) i--;
    items.splice(i, 0, { score, item });
    if (items.length > this.limit) items.pop();
  }

  result(): Array<{ score: number; item: T }> {
    return this.items;
  }
}

/**
 * Index de grands ensembles de textes (53 000 bornes) : tous les textes rembourrés sont
 * mis bout à bout dans une seule chaîne, que `indexOf` parcourt à la vitesse du moteur
 * du navigateur, au lieu d'un `includes` par texte. Seul le plus long mot de la requête
 * est cherché ainsi (c'est le plus sélectif) ; les candidats sont ensuite vérifiés mot à mot.
 */
export class TextIndex {
  private readonly blob: string;
  private readonly starts: Uint32Array;

  constructor(readonly texts: readonly string[]) {
    this.starts = new Uint32Array(texts.length);
    let offset = 0;
    for (let i = 0; i < texts.length; i++) {
      this.starts[i] = offset;
      offset += texts[i]!.length;
    }
    this.blob = texts.join('');
  }

  /** Indices (croissants) des textes qui contiennent le plus long mot de la requête. */
  candidates(query: Query): number[] {
    if (query.tokens.length === 0 || this.starts.length === 0) return [];
    const longest = query.tokens.reduce((a, b) => (b.word.length > a.word.length ? b : a));
    // Un mot de moins de 3 lettres ne compte que comme début de mot (voir `matchScore`).
    const needle = longest.word.length >= 3 ? longest.word : longest.start;
    const found: number[] = [];
    let from = 0;
    for (;;) {
      const at = this.blob.indexOf(needle, from);
      if (at < 0) return found;
      // Le texte qui contient cette position : le dernier dont le début est avant elle.
      let lo = 0;
      let hi = this.starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (this.starts[mid]! <= at) lo = mid;
        else hi = mid - 1;
      }
      found.push(lo);
      if (lo + 1 >= this.starts.length) return found;
      from = this.starts[lo + 1]!; // la suite : textes suivants seulement
    }
  }
}
