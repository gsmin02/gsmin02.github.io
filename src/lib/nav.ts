import { BLOG_TAGS } from './blog';
import { getCourses } from './quiz';

export { BLOG_TAGS } from './blog';

export type NavKey = 'about' | 'blog' | 'quiz';

export interface NavItem {
  label: string;
  href: string;
  children?: { label: string; href: string }[];
}

export interface NavGroup {
  key: NavKey;
  label: string;
  href: string;
  items: NavItem[];
}

export const getNavGroups = async (): Promise<NavGroup[]> => {
  const courses = await getCourses();
  return [
    {
      key: 'about',
      label: '소개',
      href: '/about',
      items: [
        { label: '프로필', href: '/about#profile' },
        { label: '사용하는 도구', href: '/about#tools' },
        { label: '연락처', href: '/about#contact' },
      ],
    },
    {
      key: 'blog',
      label: '블로그',
      href: '/',
      items: [
        { label: '전체 글', href: '/' },
        ...BLOG_TAGS.map((tag) => ({
          label: tag,
          href: `/tag/${encodeURIComponent(tag)}`,
        })),
      ],
    },
    {
      key: 'quiz',
      label: '퀴즈',
      href: '/quiz',
      items: courses.map((course) => ({
        label: course.label,
        href: `/quiz/${course.id}/${course.chapters[0].slug}`,
        children: course.chapters.map((chapter) => ({
          label: chapter.title,
          href: `/quiz/${course.id}/${chapter.slug}`,
        })),
      })),
    },
  ];
};
