# gsmin02.github.io

블로그와 퀴즈 학습 기능을 하나의 화면 구조로 제공하는 Astro 기반 정적 웹사이트입니다.

[웹사이트 방문](https://gsmin02.github.io)

## 주요 기능

- 태그별 블로그 게시글 탐색
- 객관식·복수 정답·주관식 퀴즈 풀이와 즉시 채점
- 문제 이동 및 브라우저 세션 기반 학습 상태 복원
- 반응형 내비게이션, 다크 모드, 사이드바 크기 조절

## 기술 스택

<p>
  <a href="https://astro.build"><img alt="Astro" src="https://img.shields.io/badge/Astro-BC52EE?style=flat-square&amp;logo=astro&amp;logoColor=white"></a>
  <a href="https://www.typescriptlang.org"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&amp;logo=typescript&amp;logoColor=white"></a>
  <a href="https://tailwindcss.com"><img alt="Tailwind CSS" src="https://img.shields.io/badge/Tailwind%20CSS-06B6D4?style=flat-square&amp;logo=tailwindcss&amp;logoColor=white"></a>
  <a href="https://nodejs.org"><img alt="Node.js" src="https://img.shields.io/badge/Node.js-5FA04E?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white"></a>
  <a href="https://pages.github.com"><img alt="GitHub Pages" src="https://img.shields.io/badge/GitHub%20Pages-222222?style=flat-square&amp;logo=githubpages&amp;logoColor=white"></a>
</p>

| 역할 | 기술 |
| --- | --- |
| 정적 페이지와 컴포넌트 | Astro |
| 브라우저 상호작용과 타입 검사 | TypeScript |
| 디자인 토큰과 반응형 UI | Tailwind CSS |
| 개발 및 빌드 도구 | Node.js |
| 정적 호스팅 | GitHub Pages |

## 아키텍처

![Astro 정적 웹사이트의 빌드·배포·브라우저 실행 아키텍처](docs/architecture.svg)

## 로컬 실행

```bash
npm install
npm run dev
```

## 주요 명령어

| 명령어 | 용도 |
| --- | --- |
| `npm run dev` | 개발 서버 실행 |
| `npm run build` | 배포용 정적 자산 생성 |
| `npm run preview` | 빌드 결과 미리보기 |
