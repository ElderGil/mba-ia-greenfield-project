// A complete request may list MAX_MULTIPART_PARTS (10 000) parts, about
// 550 kB of JSON; the Express default (100 kB) would answer 413 first.
export const JSON_BODY_LIMIT = '1mb';
