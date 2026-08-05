import type { APIRoute, GetStaticPaths } from 'astro';
import { legacyRedirects } from '../../lib/legacy-redirects';

export const getStaticPaths = (() =>
  legacyRedirects.map(({ from, to }) => {
    const [, legacyDir, file] = from.split('/');
    return {
      params: { legacyDir, legacyPage: file.replace(/\.html$/, '') },
      props: { target: to },
    };
  })) satisfies GetStaticPaths;

const escapeHtml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

export const GET = (({ props, request }) => {
  const target = String(props.target);
  const safeTarget = escapeHtml(target);
  const canonical = escapeHtml(new URL(target, request.url).href);

  return new Response(
    `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8">
    <meta name="robots" content="noindex">
    <meta http-equiv="refresh" content="0;url=${safeTarget}">
    <link rel="canonical" href="${canonical}">
    <title>페이지 이동</title>
  </head>
  <body>
    <p>새 페이지로 이동합니다. <a href="${safeTarget}">직접 이동</a></p>
  </body>
</html>
`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}) satisfies APIRoute;
