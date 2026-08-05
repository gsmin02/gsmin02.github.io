/**
 * Extracts the 601 questions embedded as CSV strings inside the legacy HTML files
 * into src/data/quiz/*.json.
 *
 * The legacy renderers (main.js, main2.js, Information_js.js) all use the same
 * lossy field splitter, and the ternary chains in those files compensate for the
 * fields it drops. This script reproduces that exact behaviour so the migrated
 * data matches what the current site renders, then reports anything that looks
 * semantically wrong instead of silently "fixing" it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'src/data/quiz');

const COURSES = [
  { dir: 'quiz', id: 'aws-1-7', label: 'AWS 1-7장', desc: '클라우드 개념부터 모니터링까지', category: 'AWS' },
  { dir: 'quiz2', id: 'aws-8-12', label: 'AWS 8-12장', desc: '고급 서비스와 시험 대비', category: 'AWS' },
  { dir: 'adsp', id: 'adsp', label: 'ADsP 자격증', desc: '데이터 분석 준전문가 3과목', category: 'ADsP' },
  { dir: 'Information', id: 'information', label: 'Information', desc: '파이썬·데이터 기초 9~14주차', category: '정보' },
];

/** The legacy splitter: `[^,]+` cannot match an empty field, so empty cells vanish. */
const splitRow = (row) => {
  const m = row.match(/(".*?"|[^,]+)/g);
  return m ? m.map((f) => f.replace(/(^"|"$)/g, '').trim()) : [];
};

const readBlock = (html) => {
  const m = html.match(/const data = `([\s\S]*?)`;/);
  if (!m) return null;
  return m[1]
    .trim()
    .split('\n')
    .slice(1)
    .map((r) => r.trim())
    .filter(Boolean);
};

const slugify = (file) =>
  path
    .basename(file, '.html')
    .replace(/^Chapter/, '')
    .replace(/_/g, '-')
    .toLowerCase() || 'index';

const parseAnswers = (raw) => {
  const value = (raw ?? '').trim();
  const letters = value.split(/\s*,\s*/).filter(Boolean);
  const valid = letters.length > 0 && letters.every((l) => /^[A-F]$/.test(l));
  return valid ? { answers: letters, note: null } : { answers: [], note: value };
};

/** Mirrors main.js (A–E) and main2.js (A–F) index juggling. */
const buildChoice = (f, withF) => {
  const hasE = Boolean(f[8]);
  const hasF = withF && Boolean(f[9]);
  const choices = [f[2], f[3], f[4], f[5]];
  if (hasE) choices.push(f[6]);
  if (hasF) choices.push(f[7]);
  const answerRaw = hasF ? f[8] : hasE ? f[7] : f[6];
  const explanation = hasF ? f[9] : hasE ? f[8] : f[7];
  return { choices: choices.filter(Boolean), answerRaw, explanation: explanation ?? '' };
};

const warnings = [];
const manifest = [];
let total = 0;

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const course of COURSES) {
  const dir = path.join(ROOT, course.dir);
  if (!fs.existsSync(dir)) continue;

  const chapters = [];
  // natural order so Chapter9 precedes Chapter10
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.html'))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

  for (const file of files) {
    const html = fs.readFileSync(path.join(dir, file), 'utf8');
    const rows = readBlock(html);
    if (!rows) continue; // redirect stubs and index pages carry no data

    const subjective = course.id === 'information';
    // quiz/ChapterPractice.html inlines a copy of the main2 renderer
    const withF = course.id !== 'aws-1-7' || file === 'ChapterPractice.html';

    const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : slugify(file);

    const questions = rows.map((row, i) => {
      const f = splitRow(row);
      const no = Number.parseInt(f[0], 10) || i + 1;
      const where = `${course.dir}/${file}#${no}`;

      if (subjective) {
        // ./img/Chapter9/1.png  ->  /img/information/Chapter9/1.png (served from public/)
        const image = f[4] ? f[4].replace(/^\.\/img\//, '/img/information/') : null;
        if (image && !fs.existsSync(path.join(dir, f[4].replace(/^\.\//, '')))) {
          warnings.push(`${where} 이미지 없음: ${f[4]}`);
        }
        return {
          no,
          question: f[1] ?? '',
          answer: f[2] ?? '',
          explanation: f[3] ?? '',
          image,
        };
      }

      const { choices, answerRaw, explanation } = buildChoice(f, withF);
      const { answers, note } = parseAnswers(answerRaw);
      if (note) warnings.push(`${where} 정답 형식 이탈: "${note}"`);
      if (choices.length < 2) warnings.push(`${where} 선택지 ${choices.length}개`);
      if (!explanation) warnings.push(`${where} 해설 없음`);

      return {
        no,
        question: f[1] ?? '',
        choices,
        answers,
        answerNote: note,
        explanation,
      };
    });

    const slug = slugify(file);
    chapters.push({ slug, title, count: questions.length, questions });
    total += questions.length;
  }

  if (chapters.length === 0) continue;

  const payload = {
    id: course.id,
    label: course.label,
    desc: course.desc,
    category: course.category,
    type: course.id === 'information' ? 'subjective' : 'multiple-choice',
    total: chapters.reduce((a, c) => a + c.count, 0),
    chapters,
  };
  fs.writeFileSync(path.join(OUT_DIR, `${course.id}.json`), JSON.stringify(payload, null, 2) + '\n');
  manifest.push({
    id: course.id,
    label: course.label,
    desc: course.desc,
    category: course.category,
    type: payload.type,
    total: payload.total,
    chapters: chapters.map((c) => ({ slug: c.slug, title: c.title, count: c.count })),
  });
}

fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`추출 완료: ${total}문항 / ${manifest.length}개 과정`);
for (const c of manifest) {
  console.log(`  ${c.label.padEnd(14)} ${String(c.total).padStart(3)}문항  ${c.chapters.length}개 챕터`);
}
if (warnings.length) {
  console.log(`\n확인 필요 ${warnings.length}건`);
  warnings.forEach((w) => console.log('  ' + w));
}
