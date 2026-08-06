import { getCollection, type CollectionEntry } from 'astro:content';

type Question = CollectionEntry<'quizChapters'>['data']['questions'][number];

export interface Chapter {
  slug: string;
  title: string;
  count: number;
  questions: Question[];
}

export interface Course {
  id: string;
  label: string;
  total: number;
  chapters: Chapter[];
}

const assertUnique = (values: (string | number)[], label: string) => {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} 값이 중복됩니다.`);
  }
};

const assertSequential = (values: number[], label: string) => {
  const sorted = [...values].sort((a, b) => a - b);
  const invalidIndex = sorted.findIndex((value, index) => value !== index + 1);
  if (invalidIndex !== -1) {
    throw new Error(`${label} 값은 1부터 빠짐없이 이어져야 합니다.`);
  }
};

const getCourseId = (entryId: string) => entryId.split('/')[0];

export const getCourses = async (): Promise<Course[]> => {
  const courseEntries = await getCollection('quizCourses');
  const chapterEntries = await getCollection('quizChapters');

  assertUnique(
    courseEntries.map(({ data }) => data.order),
    '과정 순서'
  );

  const courseIds = new Set(courseEntries.map(({ id }) => getCourseId(id)));
  const orphan = chapterEntries.find(({ id }) => !courseIds.has(getCourseId(id)));
  if (orphan) throw new Error(`${getCourseId(orphan.id)} 과정이 등록되지 않았습니다.`);

  return courseEntries
    .sort((a, b) => a.data.order - b.data.order)
    .map(({ id, data: course }) => {
      const courseId = getCourseId(id);
      const courseChapters = chapterEntries.filter(({ id }) => getCourseId(id) === courseId);
      const chapterOrders = courseChapters.map(({ data }) => data.order);

      if (courseChapters.length === 0) throw new Error(`${courseId} 과정에 챕터가 없습니다.`);
      assertUnique(chapterOrders, `${courseId} 챕터 순서`);
      assertSequential(chapterOrders, `${courseId} 챕터 순서`);

      const chapters = courseChapters
        .sort((a, b) => a.data.order - b.data.order)
        .map(({ data }) => ({
          slug: String(data.order),
          title: data.title,
          count: data.questions.length,
          questions: data.questions,
        }));

      return {
        id: courseId,
        label: course.label,
        total: chapters.reduce((sum, chapter) => sum + chapter.count, 0),
        chapters,
      };
    });
};

export const getQuizStats = (courses: Course[]) => ({
  courses: courses.length,
  chapters: courses.reduce((sum, course) => sum + course.chapters.length, 0),
  questions: courses.reduce((sum, course) => sum + course.total, 0),
});
