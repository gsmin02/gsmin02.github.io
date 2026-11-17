---
title: Kafka로 살펴본 대용량 업로드 후처리의 안정적인 구조
date: 2026-11-17
tag: 자바
summary: 업로드가 끝난 뒤의 후처리를 Kafka로 넘기는 구조를 Java 21과 Kafka 4.4로 만들어 브로커와 Worker 장애를 재현했습니다. 복제와 처리 후 커밋으로 장애 뒤에 이어 처리하고, 완료 표시가 남은 이벤트는 재전달 시 건너뛰는 흐름을 확인했습니다.
readingMinutes: 26
---

[앞 글](/blog/tus-resumable-upload-java)에서는 TUS로 대용량 파일을 끊겨도 이어서 올리는 구조를 확인했습니다. 기준으로 삼은 규모는 이번에도 같습니다. 파일 하나 최대 5GB, 한 번에 올리는 총량 최대 100GB, 파일 수 최대 3,000개입니다.

요구 규모는 GB로 표기합니다. 실험에서는 이진 단위인 GiB·MiB를 사용했으며, 요구 규모의 GB와는 바이트 수가 다릅니다.

업로드가 끝나도 할 일이 남습니다. 바이러스 검사, 썸네일 생성, 메타데이터 추출, DB 반영 같은 후처리입니다. 이 일을 업로드 응답과 떼어 놓고, 처리하던 서버가 죽어도 일을 잃지 않으려면 어떤 구조가 필요한지 확인하고 싶었습니다.

메시지 브로커로는 Apache Kafka 4.4.0을 골랐습니다. 구조가 그대로 드러나도록 Spring 같은 프레임워크 없이 Kafka 공식 Java 클라이언트만 썼습니다. 그리고 Docker Compose로 브로커 3대를 띄우고, 브로커와 처리 서버를 강제로 종료하며 결과를 확인했습니다.

> **결론**
>
> Kafka에는 파일이 아니라 "업로드가 끝났다"는 사실만 흐릅니다. 5GiB 파일의 완료 이벤트는 252바이트였습니다. 이벤트는 복제본 2개 이상에 기록돼야 성공으로 치고, 처리 서버는 일을 끝낸 뒤에만 읽은 위치를 저장합니다.
>
> 이번에는 완료 표시가 남은 이벤트의 재전달을 건너뛰는 것까지 확인했습니다. 실제 업무 결과의 중복 반영을 막으려면 처리 ID 등록과 업무 변경을 같은 DB 트랜잭션으로 묶거나, 업무 자체를 멱등하게 설계해야 합니다.

## 업로드와 후처리를 떼어 놓는 이유

후처리를 업로드 요청 안에서 바로 하면 두 일이 서로 묶입니다. 3,000개 파일이 비슷한 시점에 끝나면 후처리도 한꺼번에 몰리고, 그만큼 업로드 응답이 늦어집니다. 후처리 서버가 잠시 죽으면 그 사이에 끝난 업로드는 처리 대상에서 빠집니다.

메시지 브로커를 사이에 두면 업로드 서버는 "끝났다"는 사실만 남기고 바로 응답합니다. 처리 서버는 자기가 감당할 만큼만 가져갑니다. 처리 서버가 죽어도 사실은 브로커에 남아 있으므로, 다시 뜬 뒤 이어서 처리하면 됩니다.

## Kafka 구조 한눈에 보기

이번 구성에서 이벤트가 지나는 길은 다음과 같습니다.

```text
TUS 서버 --파일 바이트--> 스토리지(S3, 디스크)
   |
   | 업로드 완료 시 이벤트 1건 (파일 위치만 담음)
   v
Kafka 클러스터: kafka-1, kafka-2, kafka-3
   토픽 upload.completed
     파티션 0: [0][1][2][3] ...    파티션마다 리더 1개 + 복제본 2개
     파티션 1: [0][1][2] ...
     파티션 2: [0][1][2][3][4] ...
   |
   v 컨슈머 그룹 upload-processor (파티션을 나눠 맡음)
Worker 1   Worker 2   Worker 3 --파일 위치로 조회--> 스토리지
   |
   v 처리할 수 없는 이벤트
토픽 upload.completed.dlt
```

| 용어 | 뜻 | 이번 구성 |
| --- | --- | --- |
| 브로커(broker) | 메시지를 디스크에 저장하고 전달하는 서버 | `kafka-1`~`kafka-3` |
| 토픽(topic) | 같은 종류의 메시지를 모으는 이름 | `upload.completed`, `upload.completed.dlt` |
| 파티션(partition) | 토픽을 나눈 순서 있는 로그. 순서 보장과 병렬 처리의 단위 | 3개 |
| 오프셋(offset) | 파티션 안에서 메시지의 순번 | 로그에는 `p2@1620`처럼 표기 |
| 복제본(replica), ISR | 파티션을 다른 브로커에 복사한 것. ISR(in-sync replicas)은 리더를 따라잡은 복제본 집합 | 복제 3 |
| 컨슈머 그룹(consumer group) | 파티션을 나눠 맡는 Consumer(메시지를 받아 처리하는 소비자) 묶음 | `upload-processor` |
| 커밋(commit) | 그룹이 어디까지 처리했는지 브로커에 저장하는 일 | 처리 후 직접 커밋 |

Kafka 문서에 따르면 파티션 하나는 한 시점에 그룹 안의 Consumer 하나만 읽습니다. 그래서 파티션 안에서는 순서가 지켜지고, 파티션 수가 곧 동시에 일할 수 있는 Consumer의 최대 수가 됩니다. 이번 기본 설정에서는 Producer(메시지를 발행하는 생산자)가 붙인 key(파티션을 정하는 키)로 파티션이 정해지며, 파티션 수가 같으면 같은 key는 같은 파티션에 들어갑니다.

Kafka는 읽힌 메시지를 지우지 않습니다. 토픽별 보존 기간 동안 남겨 두고, 그룹마다 어디까지 읽었는지만 따로 기록합니다. 이 점이 뒤에서 볼 재처리를 가능하게 합니다.

## 검증 환경

| 파일 | 역할 |
| --- | --- |
| `UploadCompleted.java` | 업로드 완료 이벤트. Producer와 Worker가 공유하는 형식 |
| `UploadEventProducer.java` | TUS 서버의 업로드 완료 시점을 흉내 내 이벤트 발행 |
| `UploadWorker.java` | 이벤트를 받아 후처리하는 Consumer |
| `Dockerfile` | Gradle로 빌드한 뒤 JRE 이미지에서 실행 |
| `docker-compose.yml` | 브로커 3대, 토픽 생성, Worker, Producer |

Java 코드는 세 파일, 빈 줄과 주석을 포함해 196줄입니다. 의존성은 Kafka 공식 클라이언트 `kafka-clients` 4.4.0, 이벤트를 JSON으로 바꾸는 `jackson-databind`, 클라이언트 로그를 출력하는 `slf4j-simple`입니다. 브로커는 Apache Kafka 공식 이미지 `apache/kafka:4.4.0`을 썼습니다.

TUS 서버는 이번 구성에 넣지 않았습니다. Producer가 TUS 서버 대신 업로드 완료 이벤트를 만듭니다. 300개 중 1개는 5GiB, 나머지는 1~16MiB로 크기를 정해 3,000개를 보내도 합계가 100GiB를 넘지 않게 했습니다.

실제 파일도 만들지 않았습니다. Worker는 파일 크기에 비례한 시간만큼 멈춰 후처리를 흉내 냅니다. 기본 속도는 초당 500MiB로, 5GiB 파일 하나에 약 10초가 걸립니다.

## 이벤트: 파일 대신 위치를 보낸다

```java
package com.example.mq;

/**
 * 업로드 완료 이벤트. Producer(TUS 서버)와 Consumer(Worker) 사이의 계약이다.
 * 파일 바이트는 담지 않고 저장 위치(storageKey)만 담는다. (Claim Check 패턴)
 */
public record UploadCompleted(
        String uploadId,     // TUS 업로드 ID (파일 1개 단위)
        String batchId,      // 클라이언트 업로드 묶음 ID (최대 3,000개 파일)
        String fileName,
        long size,           // 바이트, 최대 5 GiB
        String storageKey,   // 실제 파일 위치 (S3 key, tusd 저장 경로 등)
        String completedAt) {

    public static final String TOPIC = "upload.completed";
    public static final String DLT_TOPIC = "upload.completed.dlt";   // 처리할 수 없는 이벤트를 격리하는 토픽
}
```

이벤트에는 파일 내용 대신 저장 위치(`storageKey`)만 담습니다. 큰 데이터는 저장소에 두고 메시지에는 위치만 넣는 방식을 Claim Check 패턴이라고 부릅니다. 짐을 맡기고 보관증만 들고 다니는 것과 같습니다.

Kafka의 기본 메시지 크기 제한은 큰 파일을 그대로 담기에 적합하지 않습니다. 이번 브로커의 `message.max.bytes`는 1,048,588바이트, Producer의 `max.request.size`는 1,048,576바이트였습니다. 둘 다 기본값이며 약 1MiB입니다. 이 설정으로는 5GiB 파일을 이벤트에 실을 수 없습니다.

5GiB 파일의 이벤트를 Kafka에서 직접 꺼내 보면 다음과 같습니다. 보기 좋게 줄을 나눴을 뿐, 실제 메시지는 공백 없는 한 줄이고 크기는 252바이트입니다.

```json
{
  "uploadId": "58f64e24-ccd4-43d7-bd60-6c12a4698403",
  "batchId": "ec03bdf2-cc32-4d64-b37f-f74bc35f1495",
  "fileName": "file-0300.bin",
  "size": 5368709120,
  "storageKey": "uploads/58f64e24-ccd4-43d7-bd60-6c12a4698403",
  "completedAt": "2026-11-17T12:24:21.828207430Z"
}
```

이벤트 형식은 Producer와 Worker 사이의 계약입니다. 업로드 서버와 Worker를 따로 배포하려면, Producer가 필드를 먼저 추가해도 기존 Worker가 깨지지 않아야 합니다. 그래서 Worker는 JSON에서 모르는 필드를 무시하도록 설정했습니다(`FAIL_ON_UNKNOWN_PROPERTIES` 끄기).

## Producer: 복제본 2개에 기록돼야 성공

Producer의 핵심은 아래 부분입니다.

```java
try (var producer = new KafkaProducer<String, String>(Map.of(
        ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, env("KAFKA_BOOTSTRAP", "localhost:9092"),
        ProducerConfig.ACKS_CONFIG, "all",                  // 리더와 ISR 복제본이 모두 기록해야 성공
        ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true,     // 재전송돼도 브로커에는 한 번만 기록
        ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class,
        ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class))) {

    for (int i = 1; i <= fileCount; i++) {
        // 300개 중 1개는 5 GiB, 나머지는 1~16 MiB → 3,000개 합계가 100 GiB 를 넘지 않는다
        long size = i % 300 == 0 ? 5 * GIB : ThreadLocalRandom.current().nextLong(1, 17) * MIB;
        totalBytes += size;
        String uploadId = UUID.randomUUID().toString();
        var event = new UploadCompleted(uploadId, batchId, "file-%04d.bin".formatted(i), size,
                "uploads/" + uploadId, Instant.now().toString());

        // key 의 해시가 파티션을 정한다. 같은 key → 같은 파티션 → 그 안에서 순서 보장
        String key = keyBy.equals("batchId") ? batchId : uploadId;
        producer.send(new ProducerRecord<>(UploadCompleted.TOPIC, key, json.writeValueAsString(event)),
                (meta, e) -> {                              // 브로커 응답(ack)을 받으면 호출
                    if (e != null) {
                        failed.incrementAndGet();
                        System.err.println("[send-failed] " + e);
                    } else {
                        perPartition.merge(meta.partition(), 1, Integer::sum);
                    }
                });
        if (intervalMs > 0) Thread.sleep(intervalMs);
    }
} // close() 는 응답을 아직 못 받은 전송이 끝날 때까지 기다린다
```

### 모든 동기화 복제본이 기록해야 성공

`acks=all`이면 리더는 ISR에 있는 복제본이 모두 기록한 뒤에 성공을 응답합니다. Kafka 문서도 메시지는 ISR의 모든 복제본이 기록해야 확정(committed)된다고 설명합니다. 여기에 브로커 설정 `min.insync.replicas=2`를 더하면, 기록한 복제본이 2개에 못 미칠 때 쓰기는 실패합니다.

복제 3과 최소 동기화 복제본 2를 함께 쓰면, 브로커 1대가 죽어도 나머지 두 복제본이 정상적인 ISR로 유지되는 동안 쓰기를 계속할 수 있습니다. 리더가 죽으면 재선출과 재시도를 거치므로 일시적인 중단은 있을 수 있습니다. 2대가 죽으면 쓰기 성공을 응답하지 않습니다. 복제본 하나에만 남은 데이터를 성공으로 처리하느니 실패로 돌려주는 쪽을 택한 설정입니다.

### 자동 재시도해도 한 번만 기록

리더가 바뀌는 도중에는 Producer가 같은 메시지를 다시 보낼 수 있습니다. `enable.idempotence=true`이면 브로커가 Producer마다 ID를 주고, 메시지에 붙은 일련번호로 중복을 걸러냅니다. 이 설정과 `acks=all`은 Kafka 4.4 클라이언트의 기본값과 같지만, 이 구조의 핵심이라 코드에 명시했습니다.

이 중복 방지는 같은 Producer 세션 안에서 클라이언트가 수행하는 자동 재시도에 적용됩니다. 애플리케이션이 다시 발행하거나 Producer를 재시작해 보내는 중복까지 제거하지는 않습니다.

### key가 파티션을 정한다

이번처럼 기본 파티셔너와 고정된 파티션 수를 쓰면 같은 key는 같은 파티션에 들어가므로 순서가 지켜집니다. 대신 그 key의 이벤트는 Worker 하나만 처리합니다. key를 묶음 ID인 `batchId`로 바꿔 300건을 보내자 모두 파티션 2로 들어갔고, Worker 한 대가 전부 처리하는 동안 나머지는 작업을 받지 못했습니다.

파일마다 후처리가 독립적이라면 순서보다 병렬 처리가 중요합니다. 그래서 기본 key는 파일 단위 ID인 `uploadId`로 두었고, 이때 3,000건은 989건, 991건, 1,020건으로 고르게 나뉘었습니다.

### 전송 결과는 비동기로 받는다

`send()`는 전송을 예약하고 브로커의 최종 응답 전에 반환합니다. 다만 메타데이터 조회나 버퍼 확보 때문에 `max.block.ms`까지 대기할 수 있으며, 기본값은 60초입니다. 반환 자체가 전송 성공을 뜻하지는 않습니다.

전송 결과는 두 번째 인자인 콜백으로 받아 성공한 파티션을 세거나 실패를 기록합니다. `close()`는 응답을 아직 받지 못한 전송이 끝날 때까지 기다립니다.

## Worker: 처리한 뒤에 커밋한다

Worker는 이벤트를 받아 후처리하는 Consumer입니다. 설정은 다음과 같습니다.

```java
var consumer = new KafkaConsumer<String, String>(Map.of(
        ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrap,
        ConsumerConfig.GROUP_ID_CONFIG, "upload-processor",    // 같은 그룹끼리 파티션을 나눠 가짐
        ConsumerConfig.GROUP_PROTOCOL_CONFIG, "consumer",      // KIP-848: 브로커가 파티션을 배정 (4.x 권장)
        ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, false,       // 처리가 끝난 뒤 직접 커밋
        ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest",   // 커밋 기록이 없으면 처음부터 읽음
        ConsumerConfig.MAX_POLL_RECORDS_CONFIG, 1,             // 오래 걸리는 처리는 1건씩 가져온다
        ConsumerConfig.MAX_POLL_INTERVAL_MS_CONFIG, 600_000,   // 1건 처리 제한 10분. 넘기면 그룹에서 제외
        ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class,
        ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class));
```

이벤트 1건을 처리하는 순서는 가져오기, 처리, 실패 시 DLT로 옮기기, 커밋입니다.

```java
while (true) {
    for (ConsumerRecord<String, String> rec : consumer.poll(Duration.ofSeconds(1))) {
        String at = "p%d@%d".formatted(rec.partition(), rec.offset());   // 파티션@오프셋
        try {
            System.out.println(at + " " + process(JSON.readValue(rec.value(), UploadCompleted.class)));
        } catch (Exception e) {
            // 다시 처리해도 실패할 메시지(poison pill)는 DLT 로 옮기고 넘어간다. 그대로 두면 파티션이 막힌다
            dlt.send(new ProducerRecord<>(UploadCompleted.DLT_TOPIC, null, rec.key(), rec.value(),
                    List.of(new RecordHeader("error", e.toString().getBytes(StandardCharsets.UTF_8))))).get();
            System.out.println(at + " -> DLT: " + e);
        }
        // 커밋 = "다음에 읽을 위치(offset+1)" 저장. 커밋 전에 죽으면 이 메시지를 다시 받는다 (at-least-once)
        consumer.commitSync(Map.of(new TopicPartition(rec.topic(), rec.partition()),
                new OffsetAndMetadata(rec.offset() + 1)));
    }
}
```

처리 자체는 `process()`가 맡습니다.

```java
// 같은 이벤트를 두 번 받아도 결과는 한 번만 반영한다 (Idempotent Consumer)
static String process(UploadCompleted e) throws Exception {
    if (!e.uploadId().matches("[0-9a-f-]{36}")) throw new IllegalArgumentException("invalid uploadId: " + e.uploadId());
    Path marker = PROCESSED_DIR.resolve(e.uploadId());
    if (Files.exists(marker)) return "skip (already processed) " + e.fileName();
    Thread.sleep(e.size() / BYTES_PER_MS);   // 파일 크기에 비례한 처리 시간 흉내 (기본값 기준 5 GiB ≈ 10초)
    Files.writeString(marker, Instant.now().toString());
    return "done %s %d MiB".formatted(e.fileName(), e.size() >> 20);
}
```

### 커밋 위치가 전달 보장을 정한다

Worker는 처리를 끝낸 뒤 `commitSync()`로 "다음에 읽을 위치"를 저장합니다. 그래서 커밋하는 값은 처리한 오프셋에 1을 더한 값입니다. 처리 도중 Worker가 죽으면 커밋이 없으므로, 그 파티션을 넘겨받은 Worker가 같은 메시지부터 다시 읽습니다.

Kafka 문서는 이 순서를 최소 한 번(at-least-once) 전달이라고 부릅니다. 메시지는 잃지 않지만 두 번 전달될 수 있습니다. 반대로 위치를 먼저 저장하고 처리하면 최대 한 번(at-most-once)이 되어, 처리 중에 죽은 메시지는 처리되지 않은 채 넘어갑니다.

기본 설정 두 개를 바꾼 이유도 여기에 있습니다. `enable.auto.commit`의 기본값은 `true`이고, 이 경우 처리 완료 시점이 아니라 정해진 주기에 맞춰 위치를 저장합니다. 처리와 커밋의 순서를 코드에서 직접 정하려고 껐습니다. `auto.offset.reset`의 기본값은 `latest`라서, 커밋 기록이 없는 그룹은 이미 쌓인 이벤트를 건너뛰고 새 이벤트부터 읽습니다. 그래서 `earliest`로 바꿨습니다.

### 완료 표시가 남은 이벤트는 건너뛴다

최소 한 번 전달에서는 중복이 생길 수 있으므로 Worker가 중복 처리를 고려해야 합니다. `process()`는 `uploadId` 이름의 표시 파일이 있으면 처리를 건너뜁니다. 이번 검증에서는 이미 표시 파일이 남은 이벤트의 재전달을 건너뛰는 것을 확인했습니다.

표시 파일은 처리를 끝낸 뒤에 쓰지만, 실제 업무 결과를 반영한 직후 표시 파일을 쓰기 전에 죽으면 결과가 다시 반영될 수 있습니다. 파일의 존재 확인과 기록도 원자적인 작업이 아니므로 동시에 처리되는 중복을 막지 못합니다. 운영에서는 유니크 키를 가진 처리 ID 등록과 업무 변경을 같은 DB 트랜잭션으로 묶거나, upsert 등 업무 자체가 반복해도 같은 결과를 내도록 설계해야 합니다.

이번에는 Worker들이 공유하는 Docker 볼륨에 표시 파일을 두었습니다. `uploadId` 형식도 먼저 검사합니다. 형식이 맞지 않으면 예외가 나서 DLT로 가고, 표시 파일 경로에 `../` 같은 값이 섞이는 것도 막습니다.

### 처리할 수 없는 이벤트는 따로 옮긴다

몇 번을 다시 처리해도 실패하는 메시지를 poison pill이라고 부릅니다. 형식이 깨진 JSON이 대표적입니다. 실패한 메시지를 커밋하지 않고 다시 시도하기만 하면, 그 파티션은 그 메시지에서 멈춥니다.

그래서 Worker는 처리에 실패한 메시지를 원본 그대로 `upload.completed.dlt` 토픽으로 옮깁니다. 예외 내용은 `error` 헤더에 남기고, 커밋한 뒤 다음 이벤트로 넘어갑니다. DLT는 Dead Letter Topic의 줄임말입니다. 이번 구현은 실패하면 바로 옮기므로, 일시적인 장애까지 DLT로 가지 않게 하려면 몇 번 재시도한 뒤 옮기는 단계가 필요합니다.

### 오래 걸리는 처리와 poll 간격

Consumer는 `poll()` 사이의 간격이 `max.poll.interval.ms`를 넘으면 실패한 것으로 간주되어 그룹에서 빠집니다. 그러면 맡던 파티션이 다른 Consumer에게 넘어가고, 처리 중이던 메시지는 다시 처리됩니다. 기본값은 5분이고, `poll()` 한 번에 가져오는 최대 건수인 `max.poll.records`의 기본값은 500건입니다.

5GiB 파일 이벤트를 500건까지 한 번에 받으면 다음 `poll()`까지 걸리는 시간을 예측할 수 없습니다. 그래서 `max.poll.records`를 1로 줄여 한 번의 `poll()`에서 처리할 작업을 한 건으로 제한했습니다. 그리고 `max.poll.interval.ms`는 가장 큰 파일의 처리 시간보다 넉넉한 10분으로 늘렸습니다.

### 종료 신호를 받으면 그룹을 떠난다

```java
// docker stop(SIGTERM) → poll() 을 깨워 루프를 빠져나온 뒤 close() 로 그룹 탈퇴를 알린다
Thread main = Thread.currentThread();
Runtime.getRuntime().addShutdownHook(new Thread(() -> {
    consumer.wakeup();
    try { main.join(); } catch (InterruptedException ignored) { }
}));
```

`KafkaConsumer`는 스레드 안전하지 않아서, 다른 스레드에서 불러도 되는 메서드는 `wakeup()`뿐입니다. 종료 훅은 `wakeup()`으로 `poll()`을 깨워 루프를 빠져나오게 한 뒤, 메인 스레드가 `finally`에서 `close()`를 마칠 때까지 기다립니다. JVM은 종료 훅이 모두 끝나면 바로 멈추기 때문입니다.

`close()`는 브로커에 그룹을 떠난다고 알립니다. 그래서 남은 Worker가 파티션을 곧바로 넘겨받습니다. 알리지 못하고 죽으면 브로커는 세션 타임아웃이 지날 때까지 기다린 뒤에야 파티션을 옮깁니다. 이 차이는 검증 결과에서 확인합니다.

### 파티션 배정은 브로커가 한다

`group.protocol=consumer`는 KIP-848에서 정의한 새 리밸런스 프로토콜을 켭니다. 리밸런스(rebalance)는 Consumer가 늘거나 줄 때 파티션을 다시 나누는 과정입니다. 새 프로토콜에서는 브로커가 배정을 계산하고, 그룹 전체를 멈추지 않고 옮겨야 할 파티션만 옮깁니다.

Kafka 4.4에서도 기본값은 이전 방식인 `classic`이라 직접 설정해야 합니다. 4.4 클라이언트에는 새 프로토콜이 운영 환경에 적용할 수 있는 상태(production-ready)라며 `group.protocol=consumer` 설정을 권하는 안내 문구가 들어 있습니다.

## 클러스터: 브로커 3대와 토픽

세 브로커가 공유하는 설정과 첫 번째 브로커는 다음과 같습니다. 나머지 두 브로커는 `KAFKA_NODE_ID`와 주소만 다릅니다.

```yaml
x-kafka-env: &kafka-env
  KAFKA_PROCESS_ROLES: broker,controller        # 한 노드가 브로커와 컨트롤러(메타데이터 관리)를 겸한다
  KAFKA_LISTENERS: PLAINTEXT://:9092,CONTROLLER://:9093
  KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT
  KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
  KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka-1:9093,2@kafka-2:9093,3@kafka-3:9093   # 과반(2대)이 살아 있어야 클러스터가 동작
  CLUSTER_ID: 4L6g3nShT-eMCtK--X86sw            # 세 노드가 같은 클러스터임을 나타내는 ID
  KAFKA_MIN_INSYNC_REPLICAS: 2                  # acks=all 쓰기가 성공하려면 최소 2개 복제본이 기록해야 함
  KAFKA_AUTO_CREATE_TOPICS_ENABLE: "false"      # 토픽은 kafka-init 이 명시적으로 만든다
  KAFKA_HEAP_OPTS: -Xms512m -Xmx512m

services:
  kafka-1:
    image: apache/kafka:4.4.0
    environment:
      <<: *kafka-env
      KAFKA_NODE_ID: 1
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka-1:9092
```

각 노드는 브로커와 컨트롤러를 겸합니다. 컨트롤러는 클러스터 메타데이터를 관리하고 파티션 리더를 뽑는 역할입니다. ZooKeeper 없이 컨트롤러끼리 합의해 메타데이터를 관리하는 이 방식을 KRaft라고 합니다. Raft 방식이라 컨트롤러 3대 중 과반인 2대가 살아 있어야 합니다.

토픽은 자동 생성을 끄고 `kafka-init` 컨테이너가 명시적으로 만듭니다. 복제 3인 토픽은 브로커 3대가 모두 등록돼야 만들 수 있으므로, 성공할 때까지 3초 간격으로 다시 시도합니다. 생성 직후 토픽 상태는 다음과 같습니다(일부 열 생략).

```text
Topic: upload.completed  PartitionCount: 3  ReplicationFactor: 3  Configs: min.insync.replicas=2
  Partition: 0  Leader: 2  Replicas: 2,3,1  Isr: 2,3,1
  Partition: 1  Leader: 3  Replicas: 3,1,2  Isr: 3,1,2
  Partition: 2  Leader: 1  Replicas: 1,2,3  Isr: 1,2,3
```

파티션마다 리더가 다른 브로커에 있습니다. 쓰기와 읽기는 리더가 맡고, 나머지 두 브로커는 리더를 따라 복사합니다. 리더가 흩어져 있으니 한 브로커가 모든 요청을 받지 않습니다.

이번처럼 한 노드가 브로커와 컨트롤러를 겸하는 구성을 결합 모드(combined mode)라고 합니다. Kafka 문서는 결합 모드를 개발 환경용으로 보고, 중요한 운영 환경에서는 피하라고 권합니다. 결합 모드에서는 컨트롤러를 브로커와 따로 재시작하거나 늘릴 수 없기 때문입니다.

## 검증 결과

검증 환경은 Docker Engine 29.9.2, Docker Compose v5.6.1입니다. Worker와 Producer는 같은 이미지를 쓰며, Producer는 `docker compose run`으로 실행할 때만 뜹니다. 시나리오는 주로 아래 명령으로 만들었습니다.

```bash
docker compose up -d --build                    # 브로커 3대, 토픽 생성, Worker 1대
docker compose run --rm producer                # 업로드 완료 이벤트 3,000건 발행
docker compose up -d --scale worker=3           # Worker를 3대로 확장
KEY_BY=batchId FILE_COUNT=300 docker compose run --rm producer
docker compose kill kafka-2                     # 브로커 1대 강제 종료(SIGKILL)
docker compose exec kafka-1 /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server kafka-1:9092 --describe --group upload-processor
```

| 시나리오 | 결과 |
| --- | --- |
| 이벤트 3,000건 발행 | 실패 0건, 합계 74.8GiB. 파티션별 989건, 991건, 1,020건 |
| 5GiB 파일의 이벤트 크기 | 252바이트 |
| Worker 1대에서 3대로 확장 | 기존 Worker는 파티션 0을 유지하고 1, 2만 넘김. 새 Worker 두 대가 하나씩 받음 |
| 5GiB 이벤트 처리 중 | 같은 파티션의 다음 이벤트가 약 10초 대기 |
| key를 `batchId`로 발행 | 300건 모두 파티션 2로 들어가 Worker 한 대가 전부 처리 |
| 깨진 JSON 1건 투입 | DLT로 옮겨지고 `error` 헤더에 원인 기록. 뒤의 이벤트는 밀리지 않음 |
| 읽은 위치를 처음으로 되돌림 | 3,300건이 다시 전달됐지만 모두 건너뜀. 새로 반영된 건 0건 |
| 처리 중인 Worker 강제 종료(SIGKILL) | 44초 뒤 다른 Worker가 같은 오프셋부터 다시 처리 |
| Worker 정상 종료(SIGTERM) | 3대가 0.6초 만에 종료되고 그룹이 바로 비워짐 |
| 발행 도중 브로커 1대 강제 종료 | 3,000건 실패 0건. 토픽의 메시지 수가 정확히 3,000 증가 |
| 브로커 2대 강제 종료 후 3건 발행 | 3건 모두 120초 뒤 `TimeoutException` |
| 2대 복구 후 | 실패로 보고된 3건이 기록되어 있었고 Worker가 처리함 |

### 실패로 보고된 이벤트가 기록되어 있었다

가장 의미 있었던 장면은 브로커 2대를 죽였을 때입니다. Producer는 120초 동안 응답을 기다리다 3건 모두 실패를 보고했습니다. 120초는 Producer 설정 `delivery.timeout.ms`의 기본값입니다. 그런데 두 브로커를 다시 띄우자 파티션 2의 끝 오프셋이 2,617에서 2,620으로 늘었고, Worker가 그 3건을 처리했습니다.

```text
[send-failed] org.apache.kafka.common.errors.TimeoutException: Expiring 3 record(s) for upload.completed-2:120032 ms has passed since batch creation. The request has not been sent, or no server response has been received yet.
worker-2  | p2@2617 done file-0001.bin 16 MiB
worker-2  | p2@2618 done file-0002.bin 7 MiB
worker-2  | p2@2619 done file-0003.bin 15 MiB
```

파티션 2의 리더인 브로커 1은 살아 있었습니다. 이벤트를 자기 로그에 쓴 뒤 다른 복제본의 기록을 기다리다 시간이 다 된 것으로 보입니다. Kafka는 ISR의 모든 복제본이 기록한 메시지만 확정으로 보고, 확정된 메시지만 Consumer에게 내줍니다. 장애 중에 오프셋이 그대로였던 것도, 복구 뒤에 3건이 나타난 것도 이 규칙으로 설명됩니다.

실패 보고는 "기록되지 않았다"가 아니라 "성공 확인을 받지 못했다"는 뜻입니다. [RPC 글](/blog/java-minimal-rpc)에서 본 타임아웃과 같은 성격입니다. 업로드 서버가 이 실패를 보고 같은 이벤트를 다시 보내면 이벤트가 두 번 기록될 수 있습니다. Worker의 중복 걸러내기가 선택이 아니라 필수인 이유입니다.

### 강제 종료된 Worker의 몫은 45초 뒤에 넘어갔다

처리 속도를 초당 100MiB로 낮춰 5GiB 이벤트 하나에 약 51초가 걸리게 했습니다. 그리고 처리를 시작하고 6초 뒤 Worker를 `SIGKILL`로 죽였습니다. 그 파티션은 44초 동안 아무도 처리하지 않았고, 그 뒤 다른 Worker가 같은 오프셋의 이벤트를 받아 51초 만에 처리를 끝냈습니다.

44초는 브로커가 Consumer를 죽은 것으로 판단하는 세션 타임아웃(`group.consumer.session.timeout.ms`, 기본 45초)에 해당합니다. 반면 `SIGTERM`으로 정상 종료한 경우에는 `close()`가 탈퇴를 알리므로 이런 대기가 없었습니다.

### 큰 파일이 같은 파티션의 작은 파일을 막았다

Worker 로그를 보면 파티션 0에서 5GiB 이벤트(오프셋 108)를 처리하는 10초 동안 다음 이벤트가 차례를 기다렸습니다. 시각은 UTC입니다.

```text
12:25:52.018  p0@106 done file-0295.bin 16 MiB
12:25:52.044  p0@107 done file-0298.bin 12 MiB
12:26:02.286  p0@108 done file-0300.bin 5120 MiB
12:26:02.310  p0@109 done file-0306.bin 10 MiB
12:26:02.321  p0@110 done file-0308.bin 3 MiB
```

파티션 안에서는 순서대로 처리하기 때문입니다. 이처럼 앞의 큰 작업이 뒤의 작업을 막는 현상을 head-of-line blocking이라고 부릅니다. 크기가 1MiB부터 5GiB까지 섞이는 이번 실험에서는 설계할 때 고려해야 합니다.

### 읽은 위치만 되돌리면 다시 흘려보낼 수 있다

재처리 시나리오에서는 Worker를 멈추고 그룹의 읽은 위치를 처음으로 되돌렸습니다. Kafka는 읽힌 메시지도 보존 기간 동안 지우지 않으므로(이번 브로커는 168시간) 3,300건이 모두 다시 전달됐습니다. Worker는 표시 파일을 보고 전부 건너뛰었습니다. 깨진 메시지는 이때 DLT로 한 번 더 들어갔으므로, DLT를 처리하는 쪽도 중복을 고려해야 합니다.

측정값은 한 PC 안의 Docker 네트워크에서 잰 값이고, 후처리는 실제 작업 대신 대기 시간으로 흉내 냈습니다. 이번 검증의 목적은 처리 속도보다 장애 뒤 이벤트가 다시 전달되는지, 완료 표시가 남은 이벤트를 건너뛰는지 확인하는 것이었습니다. 외부 업무 결과의 중복 반영 방지까지 검증한 것은 아닙니다.

## 5GB · 100GB · 3,000개 기준에 대입하기

Kafka에 흐르는 것은 이벤트뿐이라, 기준의 숫자 대부분은 Kafka가 아니라 스토리지와 후처리의 문제가 됩니다. 3,000건을 모두 합쳐도 이벤트는 약 0.75MB입니다.

| 기준 | 이번 구현 | 운영에서 더할 것 |
| --- | --- | --- |
| 파일당 5GB | 이벤트에는 위치만 담음. 5GiB 이벤트도 252바이트 | 실제 처리 시간에 맞춘 `max.poll.interval.ms` |
| 총 100GB | 이벤트 합계 약 0.75MB | 스토리지와 후처리 처리량 확보 |
| 3,000개 | 파티션 3개, Worker 최대 3대 | 목표 처리량에 맞춘 파티션 수 |
| 큰 파일과 작은 파일 혼재 | 같은 파티션에서 큰 파일이 뒤를 막음 | 큰 파일 분리 또는 Share Group |
| 이벤트 유실 | 복제 3, 최소 동기화 복제본 2, 처리 후 커밋 | 업로드 서버의 Transactional Outbox |
| 중복 반영 | 완료 표시가 남은 이벤트의 재전달을 건너뜀 | 처리 ID 등록·업무 변경을 같은 DB 트랜잭션으로 묶거나 업무 자체를 멱등하게 설계 |
| 묶음 완료 알림 | 다루지 않음 | 묶음별 완료 개수 집계 |
| 클러스터 운영 | 결합 모드 3대 | 컨트롤러를 브로커와 분리 |

오른쪽 열은 이번에 검증하지 않은 항목입니다.

### 큰 파일이 작은 파일을 막지 않게

가장 단순한 방법은 큰 파일 이벤트를 별도 토픽으로 보내고 Worker도 따로 두는 것입니다. 파티션을 늘리면 큰 파일이 같은 파티션에 몰릴 가능성은 줄지만, 막는 현상 자체가 사라지지는 않습니다.

다른 선택지는 Share Group입니다. KIP-932(Queues for Kafka)에서 정의한 기능으로, 메시지를 파티션 단위가 아니라 메시지 단위로 나눠 주고 Consumer가 메시지마다 처리 결과를 알리는 큐 방식입니다. 그래서 파티션 수보다 많은 Consumer가 동시에 일할 수 있습니다. Apache Kafka 4.2 릴리스 공지에서 운영 환경에 적용할 수 있는 상태(production-ready)로 발표됐고, 4.4에서 DLQ 지원이 추가됐습니다. 이번에는 Kafka의 기본 구조를 먼저 확인하려고 일반 컨슈머 그룹을 썼습니다.

## TUS 서버와 이어 붙이기

이벤트를 보내는 곳은 업로드가 끝나는 시점 한 곳입니다. [앞 글](/blog/tus-resumable-upload-java)의 서버라면 PATCH 처리에서 새 오프셋이 전체 길이와 같아지는 지점입니다. 조각을 받을 때마다 이벤트를 보낼 필요는 없습니다. 진행 상황은 TUS의 HEAD 요청이 이미 알려 줍니다.

tusd를 쓴다면 업로드 완료 훅이 이 자리입니다. tusd 문서에 따르면 `pre-finish` 훅은 모든 데이터를 받은 뒤 응답을 보내기 전에 실행되고, 실패하면 클라이언트가 500 응답을 받습니다. `post-finish` 훅은 응답을 보낸 뒤 실행되고, 실패해도 로그만 남습니다. 문서는 훅이 보통 재시도되지 않는다고도 적고 있습니다.

어느 쪽이든 파일 완료 기록과 이벤트 발행은 별개의 두 쓰기입니다. 둘 사이에서 서버가 죽거나 발행이 실패하면 파일은 완료됐는데 이벤트는 없는 상태가 남습니다. 이 문제의 표준 해법이 Transactional Outbox 패턴입니다. 업로드 완료 상태와 보낼 이벤트를 같은 DB 트랜잭션으로 저장하고, 별도 중계 프로세스가 이벤트를 Kafka로 보냅니다.

Outbox는 완료 상태와 발행할 이벤트 사이의 누락을 막지만, 중계 과정의 재시도로 이벤트가 중복 발행될 수 있습니다. 소비자 쪽 업무 결과의 중복 반영까지 해결하지는 않으므로, Worker에도 처리 ID 등록과 업무 변경의 원자성 또는 업무 자체의 멱등성이 필요합니다.

## 표준과 이번 구현 범위

이번 구조는 메시징 분야에서 널리 쓰이는 패턴을 최소한으로 옮긴 것입니다. 아래 이름으로 검색하면 같은 개념을 찾을 수 있습니다. EIP는 Gregor Hohpe와 Bobby Woolf의 책 『Enterprise Integration Patterns』입니다.

| 패턴 | 이번 구현 | 적용 |
| --- | --- | --- |
| Claim Check (EIP) | 이벤트에 `storageKey`만 담음 | 채택 |
| Competing Consumers (EIP) | 같은 컨슈머 그룹의 Worker 여러 대 | 채택 |
| Idempotent Receiver (EIP), Idempotent Consumer | 완료 표시가 남은 이벤트의 재전달을 건너뜀 | 단순화해 채택. 실제 업무에는 처리 ID·업무 변경의 원자성 또는 업무 자체의 멱등성 필요 |
| Dead Letter Channel (EIP) | `upload.completed.dlt` | 채택. 재시도 단계는 생략 |
| Transactional Outbox | 없음 | 미채택. 업로드 서버 쪽 과제 |
| KIP-848 리밸런스 프로토콜 | `group.protocol=consumer` | 채택 |
| KIP-932 Share Group | 없음 | 미채택. 비교 대상 |

이번에 다루지 않은 Kafka 기능은 트랜잭션을 이용한 정확히 한 번(exactly-once) 처리, 스키마 레지스트리를 통한 이벤트 형식 관리, TLS와 인증, 소비 지연(lag) 모니터링입니다. Kafka 문서도 Kafka 밖의 시스템까지 정확히 한 번 전달하려면 그 시스템의 협조가 필요하다고 설명합니다. 이번 구조는 완료 표시가 남은 이벤트의 재전달을 건너뛰는 수준이며, DB 반영이나 파일 이동 같은 외부 업무 결과를 한 번만 반영하려면 해당 시스템의 원자성 또는 멱등성 설계가 필요합니다.

## 정리

- Kafka에는 파일이 아니라 업로드가 끝났다는 사실과 파일 위치만 보냅니다. 5GiB 파일의 이벤트도 252바이트입니다.
- 이벤트는 복제본 2개 이상에 기록돼야 성공으로 칩니다. 이번 브로커 1대 장애 실험에서는 나머지 복제본과 재시도를 통해 발행을 마쳤고 유실과 중복이 없었습니다.
- Worker는 처리를 끝낸 뒤에 커밋합니다. 같은 이벤트가 다시 올 수 있으며, 이번에는 완료 표시가 남은 이벤트를 건너뛰었습니다. 실제 업무 결과에는 처리 ID 등록과 업무 변경의 원자성 또는 업무 자체의 멱등성이 필요합니다.
- 실패로 보고된 발행도 기록되어 있을 수 있습니다. 업로드 서버는 Outbox로 완료 상태와 이벤트 사이의 누락을 막고, Worker는 별도로 중복을 견뎌야 합니다.
- 파티션은 순서와 병렬 처리의 단위입니다. 파일 단위 key로 고르게 나누고, 큰 파일이 작은 파일을 막지 않도록 따로 다룹니다.

이번 검증에서 다루지 않은 부분은 업로드 서버의 Outbox 구현, DLT로 옮기기 전의 재시도, 묶음 단위 완료 알림, 컨트롤러를 분리한 운영 구성입니다.

## 참고 자료

- [Apache Kafka 4.4 문서: Design](https://kafka.apache.org/44/design/design/)
- [Apache Kafka 4.4 문서: Consumer Rebalance Protocol](https://kafka.apache.org/44/operations/consumer-rebalance-protocol/)
- [Apache Kafka 4.4 문서: KRaft](https://kafka.apache.org/44/operations/kraft/)
- [Apache Kafka 4.2.0 Release Announcement](https://kafka.apache.org/blog/2026/02/17/apache-kafka-4.2.0-release-announcement/)
- [Apache Kafka 4.4.0 Release Announcement](https://kafka.apache.org/blog/2026/10/22/apache-kafka-4.4.0-release-announcement/)
- [KIP-848: The Next Generation of the Consumer Rebalance Protocol](https://cwiki.apache.org/confluence/display/KAFKA/KIP-848%3A+The+Next+Generation+of+the+Consumer+Rebalance+Protocol)
- [KIP-932: Queues for Kafka](https://cwiki.apache.org/confluence/display/KAFKA/KIP-932%3A+Queues+for+Kafka)
- Gregor Hohpe, Bobby Woolf, Enterprise Integration Patterns: [Claim Check](https://www.enterpriseintegrationpatterns.com/patterns/messaging/StoreInLibrary.html), [Competing Consumers](https://www.enterpriseintegrationpatterns.com/patterns/messaging/CompetingConsumers.html), [Idempotent Receiver](https://www.enterpriseintegrationpatterns.com/patterns/messaging/IdempotentReceiver.html), [Dead Letter Channel](https://www.enterpriseintegrationpatterns.com/patterns/messaging/DeadLetterChannel.html)
- [microservices.io: Transactional Outbox](https://microservices.io/patterns/data/transactional-outbox.html)
- [microservices.io: Idempotent Consumer](https://microservices.io/patterns/communication-style/idempotent-consumer.html)
- [tusd 문서: Hooks](https://tus.github.io/tusd/advanced-topics/hooks/)
