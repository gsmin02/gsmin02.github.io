import courses from '../data/quiz/index.json';

export type NavKey = 'about' | 'blog' | 'quiz';

export interface NavItem {
  label: string;
  href: string;
}

export interface NavGroup {
  key: NavKey;
  label: string;
  href: string;
  items: NavItem[];
}

export const BLOG_TAGS = ['AWS', 'ADsP', '파이썬', '회고'] as const;

export const navGroups: NavGroup[] = [
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
      ...BLOG_TAGS.map((t) => ({ label: t, href: `/tag/${encodeURIComponent(t)}` })),
    ],
  },
  {
    key: 'quiz',
    label: '퀴즈',
    href: '/quiz',
    items: courses.map((c) => ({
      label: c.label,
      href: `/quiz/${c.id}/${c.chapters[0].slug}`,
    })),
  },
];

export { courses };
