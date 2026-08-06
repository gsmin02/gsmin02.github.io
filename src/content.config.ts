import { glob } from 'astro/loaders';
import { defineCollection, z } from 'astro:content';
import { BLOG_TAGS } from './lib/blog';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    tag: z.enum(BLOG_TAGS),
    summary: z.string(),
    readingMinutes: z.number().default(5),
  }),
});

const answerLetter = z.enum(['A', 'B', 'C', 'D', 'E', 'F']);
const publicImage = z
  .string()
  .refine((value) => value.startsWith('/img/') && !value.split('/').includes('..'), {
    message: '이미지는 public/img 아래의 절대 경로를 사용해야 합니다.',
  });

const quizQuestion = z
  .union([
    z
      .object({
        no: z.number().int().positive(),
        question: z.string().min(1),
        choices: z.array(z.string().min(1)).min(2).max(6),
        answers: z.array(answerLetter).min(1),
        explanation: z.string(),
      })
      .strict(),
    z
      .object({
        no: z.number().int().positive(),
        question: z.string().min(1),
        answer: z.string().min(1),
        acceptedAnswers: z.array(z.string().min(1)).optional(),
        explanation: z.string(),
        image: publicImage.nullable(),
      })
      .strict(),
  ])
  .superRefine((question, context) => {
    if ('answer' in question) {
      if (question.acceptedAnswers && !question.acceptedAnswers.includes(question.answer)) {
        context.addIssue({
          code: 'custom',
          message: '대표 정답은 허용 정답에도 포함되어야 합니다.',
          path: ['acceptedAnswers'],
        });
      }
      return;
    }
    if (new Set(question.choices).size !== question.choices.length) {
      context.addIssue({
        code: 'custom',
        message: '같은 선택지를 중복해서 지정할 수 없습니다.',
        path: ['choices'],
      });
    }
    if (new Set(question.answers).size !== question.answers.length) {
      context.addIssue({
        code: 'custom',
        message: '같은 정답을 중복해서 지정할 수 없습니다.',
        path: ['answers'],
      });
    }
    for (const [index, answer] of question.answers.entries()) {
      if (answer.charCodeAt(0) - 65 >= question.choices.length) {
        context.addIssue({
          code: 'custom',
          message: `정답 ${answer}에 해당하는 선택지가 없습니다.`,
          path: ['answers', index],
        });
      }
    }
  });

const quizCourses = defineCollection({
  loader: glob({ pattern: '*/course.json', base: './src/data/quiz' }),
  schema: z
    .object({
      order: z.number().int().positive(),
      label: z.string().min(1),
    })
    .strict(),
});

const quizChapters = defineCollection({
  loader: glob({ pattern: '*/chapters/*.json', base: './src/data/quiz' }),
  schema: z
    .object({
      order: z.number().int().positive(),
      title: z.string().min(1),
      questions: z.array(quizQuestion).min(1),
    })
    .strict()
    .superRefine((chapter, context) => {
      const numbers = new Set<number>();
      chapter.questions.forEach((question, index) => {
        if (numbers.has(question.no)) {
          context.addIssue({
            code: 'custom',
            message: `문항 번호 ${question.no}이 중복됩니다.`,
            path: ['questions', index, 'no'],
          });
        }
        numbers.add(question.no);
      });
    }),
});

export const collections = { blog, quizCourses, quizChapters };
