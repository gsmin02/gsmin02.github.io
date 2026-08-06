# 블로그 콘텐츠 관리

`blog` 디렉터리의 Markdown 파일 하나가 글 하나입니다. 파일명은 `/blog` 아래의
URL이 되며 목록, 태그 페이지, 이전 글과 다음 글은 작성일을 기준으로 자동 생성됩니다.

각 글에는 `title`, `date`, `tag`, `summary`, `readingMinutes` 메타데이터가 필요합니다.
기존 태그를 사용하면 Markdown 파일만 추가하면 됩니다. 새 태그가 필요할 때는
`src/lib/blog.ts`의 목록에 한 번만 추가합니다.

퀴즈를 추가하는 방법은 `src/data/quiz/README.md`에 분리해 두었습니다.
