// 文本查询的两个"必须显式处理"的细节，集中放在这里，避免散落到各处。
//
// 1) FTS5 的 trigram 分词器要求查询词至少 3 个字符。实测：
//      "记忆" / "黑话"（2 字）-> 0 条；"记忆检索"（4 字）-> 正常命中。
//    中文 2 字词是主力查询词，不处理就会出现"明明有这条记忆却搜不到"的静默失效。
// 2) FTS5 的 MATCH 是语法而非纯字符串：用户内容里的引号、星号之类必须转义，否则会抛错或查歪。
export const FTS_MIN_QUERY_CHARS = 3;

/** 按字符数（不是字节、也不是 UTF-16 长度）判断，中文才不会被算错。 */
export function charLength(text) {
  return Array.from(String(text ?? '')).length;
}

/** 是否够长到能交给 trigram：不够就必须走 LIKE 兜底。 */
export function ftsQueryable(text) {
  const trimmed = String(text ?? '').trim();
  return trimmed.length > 0 && charLength(trimmed) >= FTS_MIN_QUERY_CHARS;
}

/** FTS5 短语查询：整体加引号，内部双引号转义。 */
export function ftsPhrase(text) {
  return `"${String(text).replace(/"/g, '""')}"`;
}

/** LIKE 通配转义：%、_ 以及转义符本身都要处理。 */
export function likePattern(text) {
  return `%${String(text).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}
