---
title: TUS로 살펴본 대용량 업로드의 안정적인 구조
date: 2026-11-17
tag: 자바
summary: JDK로 구현한 TUS 서버와 클라이언트에서 5GiB 파일을 전송 중에 끊고 다시 이어 올렸습니다. 파일 3,000개는 저장본을 원본과 바이트 단위로 비교하고, 재실행 시 완료된 파일을 건너뛰는지 확인했습니다.
readingMinutes: 16
---

클라이언트에서 대용량 파일을 올릴 때 어떤 구조가 안정적인지 파악하고 싶었습니다. 기준으로 삼은 규모는 파일 하나 최대 5GB, 한 번에 올리는 총량 최대 100GB, 파일 수 최대 3,000개입니다.

요구 규모의 GB와 구분해, 실험 파일과 청크 크기는 GiB·MiB 단위로 정했습니다. 1GB는 1,000,000,000바이트이고 1GiB는 1,073,741,824바이트이므로, 실험에 쓴 5GiB 파일은 요구 규모의 5GB보다 조금 큽니다.

재개 가능한 업로드(resumable upload)를 위한 공개 프로토콜인 TUS 1.0.0을 골랐습니다. 프로토콜이 그대로 드러나도록 프레임워크 없이 Java 21의 JDK 표준 라이브러리만으로 서버와 클라이언트를 만들었습니다. 그리고 Docker에서 업로드 도중 클라이언트를 강제로 종료하거나 서버를 재시작하며 결과를 확인했습니다.

> **결론**
>
> 안정성은 두 가지 규칙에서 나옵니다. 서버는 디스크에 실제로 쓴 바이트 수만 오프셋으로 인정합니다. 클라이언트는 실패하면 자기가 기억하는 위치를 버리고 서버에 오프셋을 다시 물어, 그 지점부터 이어 보냅니다.

## 한 번에 올리는 업로드의 한계

일반적인 업로드는 요청 하나에 파일 전체를 담습니다. 재개 기능이 없다면 5GB 파일을 거의 다 보낸 뒤 연결이 끊겨도 처음부터 다시 보내야 합니다. 요청이 길수록 중간 프록시의 제한에 걸릴 가능성도 커집니다. 예를 들어 nginx는 기본 설정에서 1MiB를 넘는 요청 본문에 413을 돌려줍니다.

이 문제를 풀려면 두 가지가 필요합니다. 서버가 중단된 요청에서 받은 데이터를 남겨야 하고, 클라이언트가 다시 보낼 위치를 서버에 확인할 수 있어야 합니다. TUS는 이 약속을 HTTP 메서드와 헤더 몇 개로 정의한 프로토콜입니다. 요청을 미리 작은 청크로 나누는 것은 요청 시간과 재전송량을 조절하기 위한 선택입니다.

## TUS 프로토콜 한눈에 보기

TUS는 업로드를 생성, 위치 확인, 이어 쓰기의 세 단계로 나눕니다. 업로드 URL을 확보한 뒤 전송이 끊기면, 위치 확인부터 다시 하면 됩니다. 생성 요청의 응답을 받지 못해 URL을 모르는 경우에는 바로 HEAD로 조회할 수 없습니다. 아래는 이번 검증에서 오간 요청을 줄여 옮긴 것입니다.

```text
Client                                            Server
POST  /files/     Upload-Length: 5368709120   →  201  Location: /files/{id}
HEAD  /files/{id}                             →  200  Upload-Offset: 0
PATCH /files/{id} Upload-Offset: 0  (16MiB)   →  204  Upload-Offset: 16777216
PATCH ...         ── 연결 끊김: 서버는 받은 만큼 저장 ──
HEAD  /files/{id}                             →  200  Upload-Offset: 1640533096
PATCH /files/{id} Upload-Offset: 1640533096   →  204  ... 끝까지 반복
```

| 헤더 | 쓰이는 곳 | 역할 |
| --- | --- | --- |
| `Tus-Resumable` | OPTIONS 요청을 뺀 모든 요청과 응답 | 프로토콜 버전 |
| `Upload-Length` | POST 요청, HEAD 응답 | 파일 전체 크기 |
| `Location` | POST 응답 | 새로 만든 업로드의 URL |
| `Upload-Offset` | PATCH 요청, HEAD·PATCH 응답 | 서버가 저장한 바이트 수이자 다음 PATCH의 시작 위치 |
| `Tus-Max-Size` | OPTIONS 응답 | 서버가 받는 최대 크기 |

PATCH의 `Content-Type`은 항상 `application/offset+octet-stream`이어야 합니다. 명세는 HEAD 응답에 `Cache-Control: no-store`를 붙이도록 요구합니다. 중간 캐시가 오래된 오프셋을 돌려주면 클라이언트가 잘못된 위치부터 이어 쓰게 되기 때문입니다.

## 검증 환경

| 파일 | 역할 |
| --- | --- |
| `TusServer.java` | TUS 서버. JDK `HttpServer` 사용 |
| `TusClient.java` | TUS 클라이언트. JDK `HttpClient`로 청크 전송, 재시도, 재개 처리 |
| `Dockerfile` | `javac`로 컴파일한 뒤 JRE 이미지에서 실행 |
| `compose.yaml` | 상시 실행하는 서버와 필요할 때 실행하는 클라이언트 |

이번 구현은 TUS의 core(OPTIONS·HEAD·PATCH)와 `creation` 확장(POST)의 기본 흐름을 옮긴 검증용 부분 구현입니다. 메서드 대체 헤더인 `X-HTTP-Method-Override` 처리와 저장한 `Upload-Metadata`의 HEAD 응답 반환 등은 생략했습니다. 서버는 업로드 하나를 데이터 파일과 메타 파일 두 개로 저장합니다. 메타 파일에는 `Upload-Length`와 `Upload-Metadata`만 기록합니다.

서버는 아래처럼 힙을 64MiB로 제한해서 띄웠습니다. 이 상태로 5GiB 파일을 받아 파일 전체를 힙에 쌓지 않고 처리할 수 있음을 확인했습니다. `maxReqTime`은 뒤에서 설명합니다.

```yaml
tus-server:
  command: ["-Xmx64m", "-Dsun.net.httpserver.maxReqTime=120", "TusServer"]
```

## 서버: 오프셋은 파일 크기다

서버 설계의 중심은 오프셋을 따로 저장하지 않는 것입니다. HEAD와 PATCH가 돌려주는 `Upload-Offset`은 데이터 파일의 현재 크기를 그대로 읽은 값입니다. 별도로 기록한 오프셋이 없으니 기록과 실제 데이터가 어긋날 수 없습니다. 서버를 재시작해도 같은 값이 나옵니다.

PATCH 처리의 핵심은 다음과 같습니다.

```java
if (!locks.add(id)) return 423; // 같은 업로드의 이전 PATCH가 아직 진행 중 → 클라이언트가 잠시 후 재시도
try {
    long offset = Files.size(data(id));
    long length = length(id);
    if (longHeader(req, "Upload-Offset") != offset) return 409; // 클라이언트가 아는 위치 ≠ 서버 실제 위치
    long bodyLength = longHeader(req, "Content-Length");
    if (bodyLength < 0) return 400;               // 이 최소 구현은 Content-Length 필수
    if (offset + bodyLength > length) return 413; // Upload-Length를 넘겨 쓰지 않는다
    try (InputStream in = ex.getRequestBody(); OutputStream out = Files.newOutputStream(data(id), APPEND)) {
        in.transferTo(out); // 메모리에 모으지 않고 받는 즉시 디스크에 쓴다
    } catch (IOException e) {
        // 연결이 끊겨도 이미 쓴 바이트는 남긴다 → 다음 HEAD가 이 위치를 알려준다
        System.out.printf("interrupted %s at %d/%d bytes: %s%n", id, Files.size(data(id)), length, e);
        throw e;
    }
    long newOffset = Files.size(data(id));
    ex.getResponseHeaders().set("Upload-Offset", Long.toString(newOffset));
    if (newOffset == length) System.out.printf("completed %s (%d bytes)%n", id, length);
    return 204;
} finally {
    locks.remove(id);
}
```

### 끊겨도 받은 만큼은 남긴다

`in.transferTo(out)`은 요청 본문을 받는 즉시 파일 끝에 붙입니다. 연결이 끊겨 예외가 나도 이미 쓴 바이트는 지우지 않습니다. TUS 명세도 중단된 요청에서 받은 데이터를 최대한 저장하도록 권고합니다(SHOULD). 그래서 다음 HEAD가 끊긴 지점을 정확히 알려줄 수 있습니다.

위 코드가 `Content-Length`를 필수로 받는 것은 TUS 자체의 요구가 아니라 이 구현의 제약입니다. 길이 헤더 없이 `Transfer-Encoding: chunked`로 보내는 PATCH는 지원하지 않습니다.

### 같은 업로드에는 PATCH를 하나씩만

`locks`는 PATCH를 처리 중인 업로드 id의 집합입니다. 재시도한 PATCH와 아직 끝나지 않은 이전 PATCH가 같은 파일에 동시에 쓰면 데이터가 섞입니다. 그래서 이미 처리 중이면 423 Locked를 돌려주고, 클라이언트가 잠시 뒤 다시 시도하게 합니다. 409를 판정하는 오프셋 비교도 이 잠금 안에서 해야 의미가 있습니다.

423은 TUS 명세에 없는 응답입니다. TUS의 참조 구현(reference implementation)인 tusd가 같은 상황에서 423을 돌려주는 방식을 따랐습니다.

### 멈춘 연결이 잠금을 쥐고 있지 않게

잠금에는 함정이 있습니다. 클라이언트가 전원 차단이나 망 전환으로 신호 없이 사라지면, 서버는 본문이 더 오기를 계속 기다립니다. 그동안 잠금도 풀리지 않아서 같은 파일을 다시 올리려는 요청이 계속 423을 받습니다. tusd 문서도 이것을 423이 계속되는 원인으로 꼽고, v2부터는 새 요청이 이전 요청에 잠금 해제를 요청하는 방식으로 해결합니다.

JDK `HttpServer`에서는 `sun.net.httpserver.maxReqTime` 시스템 속성으로 대응했습니다. JDK 21 소스를 보면 이 시간은 요청이 시작된 때부터 본문을 끝까지 읽을 때까지에 적용되고, 넘기면 타이머가 연결을 닫습니다. 연결이 닫히면 본문을 읽던 쪽에서 예외가 나고 `finally`에서 잠금이 풀립니다.

이 값은 요청 전체에 걸리는 시간이라 청크 크기와 함께 정해야 합니다. 16MiB 청크를 120초 안에 보내려면 약 140KB/s 이상의 속도가 필요합니다. 더 느린 회선까지 받으려면 청크를 줄이거나 제한 시간을 늘립니다.

### 받을 수 없는 요청은 먼저 거절한다

POST 단계에서 `Upload-Length`가 5GiB(`Tus-Max-Size`)를 넘으면 413으로 거절합니다. 몇 GB를 받은 뒤 실패하는 것보다 생성 시점에 실패하는 편이 낫습니다. 5GB는 `int`의 최댓값(약 2.1GB)을 넘기 때문에 길이와 오프셋은 모두 `long`으로 다룹니다. 업로드 id는 32자리 16진수인지 먼저 검사해 `../` 같은 경로 조작도 막습니다.

## 클라이언트: 실패하면 서버에 다시 묻는다

클라이언트 설계의 중심은 자기 기억을 믿지 않는 것입니다. 실패하면 `offset`을 -1(모름)로 되돌립니다. 다음 반복에서 HEAD로 서버의 오프셋을 받아 그 지점부터 다시 보냅니다. 아래는 업로드 루프에서 로그 출력만 뺀 코드입니다.

```java
while (true) {
    try {
        if (url == null) url = Files.exists(state) ? URI.create(Files.readString(state)) : create(file, size, state);
        if (offset < 0) {
            offset = head(url);
            if (offset < 0) { // 404/410: 서버에서 사라진 업로드 → 새로 만든다
                Files.deleteIfExists(state);
                url = null;
                continue;
            }
        }
        if (offset == size) break;
        int n = (int) Math.min(CHUNK_SIZE, size - offset);
        raf.seek(offset);
        raf.readFully(buf, 0, n);
        offset = patch(url, offset, buf, n);
        failures = 0;
    } catch (IOException e) { // 네트워크 오류·타임아웃·409·423·5xx
        if (++failures > MAX_RETRIES) throw e;
        long delay = Math.min(30, 1L << failures); // 2, 4, 8, 16, 30, 30 ... 초
        Thread.sleep(delay * 1000);
        offset = -1; // 내 기록 대신 서버 오프셋(HEAD)을 믿는다
    }
}
```

### 청크로 나눠 보내는 이유

명세는 남은 데이터를 PATCH 한 번에 보내기를 기본으로 권장하고, 여러 요청으로 나누는 것도 허용합니다. 이번에는 16MiB 청크로 나눴습니다. 실패해도 다시 보낼 양이 최대 16MiB이고, 요청이 짧게 끝나서 앞의 요청 시간 제한을 현실적인 값으로 둘 수 있기 때문입니다. 대신 요청 수가 늘어납니다. 5GiB 파일이면 PATCH가 320번 나갑니다.

### 재시도할 오류와 포기할 오류

| 응답 | 의미 | 대응 |
| --- | --- | --- |
| 409 | 오프셋이 서버와 다름 | HEAD로 다시 확인한 뒤 재시도 |
| 423 | 이전 PATCH가 아직 진행 중 | 기다렸다가 재시도 |
| 5xx, 네트워크 오류, 타임아웃 | 일시 장애 | 기다렸다가 HEAD 후 재시도 |
| HEAD의 404, 410 | 서버에서 업로드가 사라짐 | 새로 생성 |
| 400, 412, 413, 415 | 형식·버전·크기 오류 | 재시도하지 않고 실패 처리 |

공통 전송 함수는 409·423·5xx를 `IOException`으로 바꿔 네트워크 오류와 같은 방식으로 재시도합니다. 대기 시간은 2초에서 시작해 두 배씩 늘고 30초에서 멈춥니다(지수 백오프). 연속 실패에 따른 재시도를 10번까지 허용하며, 그 대기 시간의 합계는 210초입니다. 실제 소요 시간에는 각 요청과 타임아웃에 걸린 시간도 더해집니다. PATCH가 한 번 성공하면 실패 횟수는 다시 0이 됩니다.

### 프로세스가 죽어도 이어 올린다

POST로 업로드를 만들면 받은 URL을 곧바로 상태 파일에 기록합니다. 상태 파일 이름은 파일 경로, 크기, 수정 시각으로 만든 지문입니다. 클라이언트가 죽었다 다시 떠도 같은 파일이면 같은 URL을 찾아 HEAD부터 시작합니다. 이미 끝난 파일은 HEAD 한 번으로 건너뛰므로, 3,000개를 올리다 멈춰도 처음부터 다시 올리지 않습니다.

### 동시 업로드 수는 고정한다

파일은 4개짜리 고정 스레드 풀에서 올립니다. 활성 업로드는 최대 4개이며, 직접 할당한 16MiB 청크 배열의 합계는 최대 64MiB입니다. `HttpClient` 내부의 청크 복사와 버퍼에는 별도 메모리가 필요합니다. 전체 파일 목록과 대기 작업도 파일 수에 따라 늘어나므로, 이 값이 클라이언트 전체 메모리의 상한은 아닙니다.

## Java 21에서 만난 함정: 가상 스레드 pinning

Java 21이라면 서버 요청 처리에 가상 스레드를 쓰고 싶어집니다. 그런데 JDK 21의 `HttpServer`는 요청 본문을 `synchronized` 메서드 안에서 읽습니다. JEP 444에 따르면 가상 스레드는 `synchronized` 블록이나 메서드를 실행하는 동안 캐리어 스레드에 고정(pinning)되어, 블로킹 작업 중에도 캐리어에서 내려오지 못합니다.

서버 실행기를 가상 스레드로 바꾸고 `-Djdk.tracePinnedThreads=short` 옵션을 켠 뒤 느린 PATCH를 보내 확인했습니다.

```text
VirtualThread[#36]/runnable@ForkJoinPool-1-worker-1 reason:MONITOR
    jdk.httpserver/sun.net.httpserver.Request$ReadStream.read(Request.java:315) <== monitors:1
```

캐리어 스레드는 기본적으로 CPU 코어 수만큼 있습니다. 느린 업로드가 캐리어를 하나씩 붙잡으면 동시 업로드가 많을 때 문제가 될 수 있습니다. JEP 444도 pinning이 동작을 틀리게 만들지는 않지만 확장성을 떨어뜨릴 수 있다고 설명합니다. 그래서 서버는 플랫폼 스레드 풀(`Executors.newCachedThreadPool()`)을 썼습니다. 이 제약은 JDK 24의 JEP 491에서 해소되었습니다.

## 검증 결과

| 시나리오 | 결과 |
| --- | --- |
| 프로토콜 규칙 12개 항목 | curl로 확인. 정상 응답과 400·404·409·412·413·415가 모두 기대값과 일치 |
| 멈춘 연결 | 제한 시간 5초, 100KB/s 전송. 진행 중 두 번째 PATCH는 423을 받음. 약 7초 뒤 서버가 연결을 끊었고 받은 589,594바이트는 남음. 그 지점부터 이어 보내 해시 일치 |
| 5GiB, 30%에서 클라이언트 강제 종료 | 서버가 1,640,533,096바이트에서 멈춤. 재실행한 클라이언트가 그 지점부터 이어 보냄 |
| 5GiB, 60%에서 서버 재시작 | 재시도 1회 후 3,497,471,080바이트부터 이어 보내 완료 |
| 5GiB 무결성과 메모리 | 원본과 저장본의 SHA-256 일치. 업로드 중 서버 컨테이너 메모리 103.1MiB |
| 3,000개 파일 (합계 375MB) | 8초, 실패 0건, 재시도 0회. 3,000개 모두 원본과 바이트 일치 |
| 같은 대상 재실행 | 5GiB는 1초, 3,000개는 3초 만에 HEAD만 보내고 종료 |

가장 의미 있었던 장면은 클라이언트를 강제 종료했을 때입니다. 서버가 멈춘 1,640,533,096바이트는 16MiB의 배수가 아니었습니다. 서버가 마지막 청크의 일부까지 저장했다는 뜻입니다. 클라이언트가 자기가 마지막으로 성공한 위치부터 보냈다면 409를 받았을 것입니다. 서버에 다시 묻는 구조라서 그 지점부터 바로 이어졌습니다.

측정값은 같은 PC 안의 Docker 네트워크에서 잰 값이라 실제 회선 성능과는 다릅니다. 이번 검증의 목적은 속도가 아니라 중단과 재개가 정확한지 확인하는 것이었습니다.

## 5GB · 100GB · 3,000개 기준에 대입하기

TUS는 파일 하나 단위의 프로토콜입니다. 파일당 5GB 제한은 TUS 안에서 해결되지만, 총 100GB나 3,000개 같은 묶음 단위 제한은 TUS 밖에 따로 두어야 합니다.

| 기준 | 이번 구현 | 운영에서 더할 것 |
| --- | --- | --- |
| 파일당 5GB | 실험 서버는 POST에서 5GiB 초과를 413으로 거절, 스트리밍 저장 | 실제 정책 단위에 맞춘 제한값과 디스크 여유 확인 |
| 총 100GB | 다루지 않음 | 업로드 전에 묶음의 총량과 개수를 검증하고 용량 예약 |
| 3,000개 | 동시 4개, 재실행 시 완료분 건너뜀 | 작은 파일의 요청 수 줄이기 |
| 무결성 | 검증 스크립트에서 사후 해시 비교 | 청크별 또는 완료 시 해시 검증 |
| 버려진 업로드 | 없음 | 만료 시각을 두고 주기적으로 정리 |
| 서버 2대 이상 | 1대 | 공유 스토리지와 분산 잠금 |

오른쪽 열은 이번에 검증하지 않은 항목입니다. 몇 가지는 TUS 확장으로 정의되어 있습니다. 작은 파일은 POST에 첫 데이터를 함께 싣는 `creation-with-upload`로 요청 수를 줄일 수 있습니다. 무결성은 `checksum`, 만료는 `expiration` 확장이 다룹니다.

### 프록시를 둔다면

운영에서는 서버 앞에 nginx 같은 프록시를 두는 경우가 많습니다. nginx의 기본값 중 두 가지는 TUS와 맞지 않습니다.

- `client_max_body_size`(기본 1m): 1MiB를 넘는 요청 본문에 413을 돌려줍니다. 청크 크기보다 크게 잡아야 합니다.
- `proxy_request_buffering`(기본 on): 요청 본문을 전부 받은 뒤에 서버로 넘깁니다. 중간에 끊긴 청크는 서버에 닿지 않으므로 받은 만큼 남기는 서버 동작이 의미를 잃습니다. off로 두면 받는 즉시 서버로 넘깁니다.

nginx의 본문 수신 타임아웃(`client_body_timeout`, 기본 60초)은 연속된 두 읽기 사이의 간격에 적용됩니다. 요청 전체 시간에 적용되는 `maxReqTime`과 기준이 다르므로 두 값을 함께 정할 때 주의해야 합니다.

## 표준과 이번 구현 범위

기준 표준은 tus 1.0.0입니다. IETF HTTP 워킹 그룹은 TUS를 바탕으로 Resumable Uploads for HTTP를 표준화하고 있습니다. 2026년 11월 기준 최신본은 draft-15이며 아직 RFC가 아닙니다. 이번 구현은 tus 1.0.0의 기본 흐름을 참고한 부분 구현이며, 초안은 개념을 비교하는 데만 참고했습니다.

| 개념 | tus 1.0.0 | IETF draft-15 |
| --- | --- | --- |
| 업로드 생성 | POST, 201 | POST 등, 104 중간 응답 |
| 위치 확인 | HEAD | HEAD |
| 이어 쓰기 | PATCH | PATCH |
| 완료 판단 | 오프셋이 전체 길이와 같음 | `Upload-Complete` 헤더 |
| 위치 불일치 | 409 | 409와 올바른 오프셋 |
| 크기 제한 | `Tus-Max-Size` | `Upload-Limit` |

PATCH 본문의 형식은 tus 1.0.0이 `application/offset+octet-stream`, 초안이 `application/partial-upload`입니다.

이번에 구현하지 않은 tus 확장은 `checksum`, `termination`, `expiration`, `concatenation`, `creation-with-upload`, `creation-defer-length`입니다. 생성, 위치 확인, 이어 쓰기라는 핵심 흐름에 집중하기 위해서입니다.

## 정리

- 오프셋의 기준은 서버 디스크 하나에만 둡니다. 서버는 파일 크기를 오프셋으로 쓰고, 클라이언트는 실패하면 HEAD로 다시 묻습니다.
- 끊긴 요청에서 받은 데이터를 버리지 않으면, 재개 위치가 청크 경계와 달라도 정확히 이어집니다.
- 같은 업로드에 대한 동시 쓰기는 잠금으로 막고, 멈춘 연결이 잠금을 쥐고 있지 않도록 요청 시간 제한을 둡니다.
- 총량과 개수 같은 묶음 단위 제한은 TUS 밖의 계층에서 다룹니다.

이번 검증에서 다루지 않은 부분은 서버를 2대 이상 둘 때의 공유 스토리지와 분산 잠금, 청크 단위 무결성 검증, 묶음 단위 제한입니다.

## 참고 자료

- [tus 1.0.0 Resumable Upload Protocol](https://tus.io/protocols/resumable-upload)
- [IETF Resumable Uploads for HTTP, draft-15](https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-resumable-upload-15)
- [tusd 문서: Upload Locks](https://tus.github.io/tusd/advanced-topics/locks)
- [nginx ngx_http_core_module](https://nginx.org/en/docs/http/ngx_http_core_module.html)
- [nginx ngx_http_proxy_module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
- [JEP 444: Virtual Threads](https://openjdk.org/jeps/444)
- [JEP 491: Synchronize Virtual Threads without Pinning](https://openjdk.org/jeps/491)
