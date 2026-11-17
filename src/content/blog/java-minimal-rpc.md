---
title: "Java 21로 최소 RPC 구현하기: 스텁부터 부분 실패까지"
date: 2026-11-17
tag: 자바
summary: 동적 프록시, Java 직렬화, TCP 소켓만으로 RPC를 구현하고, 원격 호출이 로컬 호출처럼 보이는 원리와 그 착시가 깨지는 부분 실패를 Docker Compose로 확인했습니다.
readingMinutes: 15
---

RPC(Remote Procedure Call)는 다른 프로세스에 있는 함수를 로컬 함수처럼 호출하게 해 주는 방식입니다. gRPC 같은 프레임워크를 쓰면 이 과정은 코드 생성과 런타임 라이브러리 뒤로 숨습니다. 숨은 부분을 직접 확인하려고 외부 라이브러리 없이 Java 21 표준 라이브러리만으로 최소한의 RPC를 만들었습니다.

결과물은 Java 파일 7개, 빈 줄과 주석을 포함해 194줄입니다. 이 코드를 Docker Compose로 두 컨테이너에 나눠 띄우고 정상 호출, 예외 전파, 부분 실패를 차례로 확인했습니다.

> **결론**
>
> 계약 인터페이스의 메서드는 로컬 호출과 같은 문법으로 호출할 수 있습니다. 이 예제에서는 서버에서 던진 `ArithmeticException`도 같은 타입으로 잡혔습니다. 하지만 클라이언트가 타임아웃으로 실패 처리한 호출을 서버는 나중에 실행했습니다.

## RPC를 이루는 다섯 부분

RPC의 기본 구조는 Birrell과 Nelson이 1984년 논문 "Implementing Remote Procedure Calls"에서 정리했습니다. 호출하는 쪽과 실행하는 쪽 사이에 스텁(stub)을 하나씩 두고, 스텁이 호출을 메시지로 바꿔 통신 계층에 넘기는 구조입니다. 논문의 다섯 구성 요소와 이번 구현을 나란히 놓으면 다음과 같습니다.

| 논문의 구성 요소 → 이번 구현 | 역할 |
| --- | --- |
| user → `CalculatorClient` | 원격 함수 호출 |
| user-stub → `RpcClient` | 호출 대상과 인자를 메시지로 포장해 전송, 결과를 풀어 반환 |
| RPCRuntime → TCP 소켓 | 요청과 응답의 바이트를 TCP 연결로 송수신 |
| server-stub → `RpcServer` | 메시지를 풀어 실제 함수 호출, 결과 포장 |
| server → `CalculatorServer` | 실제 함수 구현 |

스텁이 인자를 바이트로 포장하는 일을 마샬링(marshalling), 푸는 일을 언마샬링(unmarshalling)이라고 합니다. 이번 구현에서는 Java 직렬화가 이 일을 맡습니다. 서버 쪽 스텁은 Java RMI 등에서 스켈레톤(skeleton)이라고도 부르며, 이 글도 그 이름을 씁니다.

양쪽 스텁이 같은 함수 목록을 알아야 하므로 둘이 공유하는 계약이 필요합니다. 논문에서는 인터페이스 모듈로부터 스텁 코드를 자동 생성했고, gRPC는 `.proto` 파일로 같은 일을 합니다. 이번 구현에서는 Java 인터페이스 `Calculator`가 계약입니다. 스텁은 코드를 생성하지 않고 런타임에 동적 프록시로 만듭니다.

## 프로젝트 구성

```text
Java_RPC/
├── Dockerfile
├── compose.yml
└── src/rpc/
    ├── Calculator.java          계약
    ├── RpcRequest.java          요청 메시지
    ├── RpcResponse.java         응답 메시지
    ├── RpcClient.java           클라이언트 스텁
    ├── RpcServer.java           서버 스켈레톤
    ├── CalculatorServer.java    서버 애플리케이션
    └── CalculatorClient.java    클라이언트 애플리케이션
```

`RpcClient`와 `RpcServer`는 `Calculator`를 직접 참조하지 않는 범용 코드입니다. 인터페이스 타입을 매개변수로 받으므로 다른 인터페이스에도 같은 방식으로 쓸 수 있습니다.

## 호출 한 번의 흐름

`calculator.add(2, 3)` 한 줄이 실행되면 요청과 응답이 다음 경로로 오갑니다.

```text
[client container]                              [server container]
CalculatorClient                                CalculatorServer.add(2, 3)
  | calculator.add(2, 3)                          ^ method.invoke(impl, args)
  v                                               |
RpcClient (stub) --RpcRequest("add", [2, 3])--> RpcServer (skeleton)
                 <--RpcResponse(5, null)-------
```

1. `calculator`는 실제 구현 객체가 아니라 `Proxy.newProxyInstance`가 런타임에 만든 프록시입니다. 계약 인터페이스의 메서드를 호출하면 `RpcClient`의 호출 처리기로 들어갑니다.
2. 클라이언트 스텁은 메서드 이름과 인자로 `RpcRequest`를 만들고, 직렬화해 TCP로 보냅니다.
3. 서버 스켈레톤은 받은 바이트를 역직렬화하고, 계약 인터페이스에서 이름이 `add`인 메서드를 찾아 구현 객체에 실행합니다.
4. 결과는 `RpcResponse`에 담겨 같은 연결로 돌아오고, 프록시가 이를 `add`의 반환값으로 돌려줍니다.

## 계약과 메시지

계약은 평범한 Java 인터페이스입니다.

```java
package rpc;

/**
 * RPC 계약(contract). 클라이언트와 서버가 공유하는 약속은 이 인터페이스뿐이다.
 * gRPC의 .proto 같은 IDL(Interface Definition Language) 역할을 Java 인터페이스가 맡는다.
 */
public interface Calculator {

    int add(int a, int b);

    int divide(int a, int b);
}
```

메시지는 record 두 개입니다. 요청에는 메서드 이름과 인자를, 응답에는 결과와 예외 중 하나를 담습니다. 두 record의 필드 구성이 곧 이 RPC의 프로토콜입니다.

```java
package rpc;

import java.io.Serializable;

/** 요청 메시지(클라이언트 → 서버). 어떤 메서드를 어떤 인자로 호출할지 담는다. */
public record RpcRequest(String method, Object[] args) implements Serializable {
}
```

```java
package rpc;

import java.io.Serializable;

/** 응답 메시지(서버 → 클라이언트). 정상 결과(result)와 서버에서 난 예외(error) 중 하나만 채워진다. */
public record RpcResponse(Object result, Throwable error) implements Serializable {
}
```

`Serializable`을 구현한 record는 `ObjectOutputStream`으로 바이트로 바꿀 수 있습니다. 다만 record에 담기는 인자·결과·예외와 그 안에서 실제로 직렬화되는 객체도 모두 직렬화할 수 있어야 합니다. 수신 측에는 메시지와 전송되는 객체의 클래스 정의도 있어야 합니다.

응답의 `error`가 `Throwable` 타입이라는 점이 뒤에서 볼 예외 전파의 핵심입니다.

## 클라이언트 스텁: RpcClient

```java
package rpc;

import java.io.IOException;
import java.io.ObjectInputStream;
import java.io.ObjectOutputStream;
import java.io.UncheckedIOException;
import java.lang.reflect.Proxy;
import java.net.ConnectException;
import java.net.Socket;

/**
 * 클라이언트 스텁(client stub).
 * 인터페이스 메서드 호출을 가로채 요청 메시지로 바꿔 서버에 보내고, 응답을 반환값이나 예외로 되돌린다.
 */
public final class RpcClient {

    private RpcClient() {
    }

    /** contract 인터페이스를 구현한 프록시(스텁)를 만든다. 호출하는 쪽에서는 로컬 객체와 구별되지 않는다. */
    public static <T> T create(Class<T> contract, String host, int port) {
        return contract.cast(Proxy.newProxyInstance(
                contract.getClassLoader(),
                new Class<?>[] {contract},
                (proxy, method, args) -> call(host, port, new RpcRequest(method.getName(), args))));
    }

    /** 원격 호출 1회: 연결 → 요청 전송 → 응답 수신. 호출마다 연결을 새로 연다. */
    private static Object call(String host, int port, RpcRequest request) throws Throwable {
        RpcResponse response;
        try (Socket socket = connect(host, port);
             var out = new ObjectOutputStream(socket.getOutputStream())) {
            socket.setSoTimeout(5_000);                               // 응답 대기 상한. 원격 호출은 영영 안 돌아올 수 있다
            out.writeObject(request);                                 // 마샬링: 요청 객체 → 바이트
            out.flush();
            var in = new ObjectInputStream(socket.getInputStream()); // 요청을 보낸 뒤에 연다(먼저 열면 헤더 대기로 교착)
            response = (RpcResponse) in.readObject();                 // 언마샬링: 바이트 → 응답 객체
        } catch (IOException e) {
            throw new UncheckedIOException("RPC transport failure", e); // 통신 실패: 로컬 호출에는 없는 실패 유형
        }
        if (response.error() != null) {
            throw response.error();                                   // 서버에서 난 예외를 호출한 자리에서 다시 던진다
        }
        return response.result();
    }

    /** 서버가 아직 포트를 열기 전이면(연결 거부) 잠시 후 재시도한다. 요청을 보내기 전이라 중복 실행 위험이 없다. */
    private static Socket connect(String host, int port) throws IOException, InterruptedException {
        for (int attempt = 1; ; attempt++) {
            try {
                return new Socket(host, port);
            } catch (ConnectException e) {
                if (attempt == 20) {
                    throw e;
                }
                Thread.sleep(250);
            }
        }
    }
}
```

### 동적 프록시

`Proxy.newProxyInstance`는 주어진 인터페이스를 구현하는 클래스를 런타임에 만듭니다. 이 프록시의 계약 인터페이스 메서드를 호출하면 세 번째 인자인 람다(`InvocationHandler`)가 실행됩니다. 람다는 호출된 메서드의 이름과 인자로 `RpcRequest`를 만들어 `call`에 넘깁니다. gRPC가 `.proto`에서 생성하는 스텁 코드를 이 호출 하나가 대신합니다.

`Object` 메서드의 동작은 이 최소 구현에서 별도로 처리하지 않았습니다. `getClass()`는 로컬에서 실행됩니다. `toString()`과 `hashCode()`는 호출 처리기로 들어오지만 서버 계약에 없어 `UndeclaredThrowableException`이 발생합니다.

### 스트림을 여는 순서

`ObjectInputStream` 생성자는 상대가 보낸 스트림 헤더를 읽을 때까지 멈춥니다. 클라이언트와 서버가 모두 입력 스트림부터 열면 서로의 헤더를 기다리느라 둘 다 멈춥니다. 그래서 클라이언트는 요청을 보내고 `flush`한 뒤에 입력 스트림을 엽니다.

### 예외 변환

서버에서 온 예외는 `throw response.error()`로 그대로 다시 던집니다. 반면 직렬화와 소켓 I/O에서 발생한 `IOException`은 `UncheckedIOException`으로 감쌉니다. `IOException`은 `Calculator` 메서드에 선언되지 않은 checked 예외라서, 그대로 던지면 프록시가 `UndeclaredThrowableException`으로 한 번 더 감싸 원인이 잘 보이지 않습니다. 로컬 호출에는 없던 실패 유형이 인터페이스 밖으로 드러나는 지점이기도 합니다.

### 타임아웃과 연결 재시도

원격 호출은 응답이 오지 않을 때 상대가 죽었는지 느린지 구별할 수 없습니다. 이 구현은 `setSoTimeout(5_000)`으로 소켓 입력 스트림의 각 `read()`가 데이터를 기다리는 시간을 5초로 제한합니다. 연결과 쓰기에는 이 제한이 적용되지 않으며, 호출 전체의 마감 시간(deadline)은 설정하지 않았습니다. 응답이 조금씩 도착하면 전체 수신 시간은 5초를 넘을 수 있습니다.

`connect`는 `ConnectException`(연결 거부)이 나면 250ms 간격으로 최대 20번까지 연결을 시도합니다. 연결이 거부됐다면 요청이 아직 서버에 닿지 않았으므로, 다시 시도해도 서버에서 두 번 실행될 위험이 없습니다. Docker Compose의 `depends_on`은 서버 컨테이너가 실행될 때까지만 기다리고 포트가 열릴 때까지는 기다리지 않습니다. 그 사이의 공백을 이 재시도가 메웁니다. 반대로 타임아웃 뒤에는 재시도하지 않습니다. 그 이유는 검증 2에서 확인합니다.

## 서버 스켈레톤: RpcServer

```java
package rpc;

import java.io.IOException;
import java.io.ObjectInputStream;
import java.io.ObjectOutputStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.Arrays;

/**
 * 서버 스켈레톤(server skeleton).
 * 요청 메시지를 받아 실제 구현 객체의 메서드를 리플렉션으로 호출하고, 결과를 응답 메시지로 돌려준다.
 */
public final class RpcServer {

    private RpcServer() {
    }

    /** impl을 contract 인터페이스로 공개한다. 연결마다 가상 스레드(Java 21) 하나가 처리한다. */
    public static <T> void serve(int port, Class<T> contract, T impl) throws IOException {
        try (var server = new ServerSocket(port)) {
            System.out.println("[server] listening on " + port);
            while (true) {
                Socket socket = server.accept();
                Thread.startVirtualThread(() -> handle(socket, contract, impl));
            }
        }
    }

    private static void handle(Socket socket, Class<?> contract, Object impl) {
        try (socket;
             var in = new ObjectInputStream(socket.getInputStream());
             var out = new ObjectOutputStream(socket.getOutputStream())) {
            var request = (RpcRequest) in.readObject();  // 언마샬링: 바이트 → 요청 객체
            var response = dispatch(contract, impl, request);
            System.out.printf("[server] %s %s -> %s%n", request.method(), Arrays.toString(request.args()), response);
            out.writeObject(response);                   // 마샬링: 응답 객체 → 바이트(close 시 flush)
        } catch (IOException | ClassNotFoundException e) {
            System.err.println("[server] connection error: " + e);
        }
    }

    private static RpcResponse dispatch(Class<?> contract, Object impl, RpcRequest request) {
        try {
            for (Method method : contract.getMethods()) {         // 계약에 선언된 메서드만 원격 호출을 허용한다
                if (method.getName().equals(request.method())) { // 이름으로만 찾으므로 오버로딩은 지원하지 않는다
                    return new RpcResponse(method.invoke(impl, request.args()), null);
                }
            }
            return new RpcResponse(null, new NoSuchMethodException(request.method()));
        } catch (InvocationTargetException e) {
            return new RpcResponse(null, e.getCause());           // 구현이 던진 예외(예: ArithmeticException)를 그대로 싣는다
        } catch (IllegalAccessException e) {
            return new RpcResponse(null, e);
        }
    }
}
```

### 연결마다 가상 스레드 하나

`serve`는 연결을 받을 때마다 `Thread.startVirtualThread`로 가상 스레드를 하나 띄웁니다. 가상 스레드는 Java 21에서 정식 기능이 된 경량 스레드입니다(JEP 444). 연결마다 스레드를 하나씩 써도 부담이 적으므로, 블로킹 I/O 코드를 그대로 단순하게 쓸 수 있습니다.

### 계약에 있는 메서드만 호출

`dispatch`는 `contract.getMethods()`, 즉 계약 인터페이스에 선언된 메서드 안에서만 이름을 찾습니다. 구현 클래스에서 찾으면 `getClass`, `wait` 같은 `Object`의 메서드까지 원격으로 호출할 수 있게 됩니다. 이름만 비교하므로 오버로딩은 지원하지 않습니다.

### 원래 예외 꺼내기

리플렉션으로 호출한 메서드가 예외를 던지면 `method.invoke`는 그 예외를 `InvocationTargetException`으로 감싸서 던집니다. 스켈레톤은 `getCause()`로 원래 예외를 꺼내 응답에 담습니다. 그래서 클라이언트는 `InvocationTargetException`이 아니라 `ArithmeticException`을 받습니다. Java RMI도 원격 메서드가 던진 예외를 클라이언트에서 다시 던지는 방식이고, gRPC는 예외 객체 대신 상태 코드와 메시지를 보냅니다.

## 애플리케이션

서버 애플리케이션은 계약을 구현하고 RPC 서버를 띄웁니다. 구현 코드는 RPC를 전혀 모르는 평범한 Java 코드입니다.

```java
package rpc;

import java.io.IOException;

/** 서버 애플리케이션. 계약(Calculator)의 실제 구현은 서버 쪽에만 있다. */
public class CalculatorServer implements Calculator {

    @Override
    public int add(int a, int b) {
        return a + b;
    }

    @Override
    public int divide(int a, int b) {
        return a / b; // b == 0 이면 ArithmeticException. 이 예외가 클라이언트까지 전달된다
    }

    public static void main(String[] args) throws IOException {
        RpcServer.serve(9090, Calculator.class, new CalculatorServer());
    }
}
```

클라이언트 애플리케이션은 구현 없이 계약만으로 원격 호출을 하고, 결과를 기대값과 비교합니다. 비교가 어긋나면 `AssertionError`로 끝나므로 종료 코드가 1이 됩니다.

```java
package rpc;

/** 클라이언트 애플리케이션. 구현 없이 계약(Calculator)만으로 원격 호출하고 결과를 검증한다. */
public class CalculatorClient {

    public static void main(String[] args) {
        String host = args.length > 0 ? args[0] : "localhost";
        Calculator calculator = RpcClient.create(Calculator.class, host, 9090);

        // 1) 정상 호출: 로컬 메서드 호출과 똑같이 보이지만 실제 계산은 서버 프로세스에서 일어난다
        check("add(2, 3)", calculator.add(2, 3), 5);

        // 2) 예외 전파: 서버에서 던진 예외가 직렬화되어 건너와 이 자리에서 다시 던져진다
        try {
            calculator.divide(1, 0);
            throw new AssertionError("divide(1, 0) should throw ArithmeticException");
        } catch (ArithmeticException e) {
            check("divide(1, 0)", e.toString(), "java.lang.ArithmeticException: / by zero");
        }
    }

    private static void check(String call, Object actual, Object expected) {
        if (!expected.equals(actual)) {
            throw new AssertionError(call + ": expected " + expected + " but was " + actual);
        }
        System.out.println("[client] " + call + " -> " + actual + "  OK");
    }
}
```

## 두 컨테이너로 실행하기

빌드 도구 없이 JDK 이미지 안에서 `javac`로 컴파일합니다. 이미지는 하나만 만들고, 어떤 메인 클래스를 실행할지는 compose의 `command`로 정합니다.

```dockerfile
# 한 이미지로 서버와 클라이언트를 모두 실행한다. 어떤 메인 클래스를 띄울지는 compose의 command가 정한다.
FROM eclipse-temurin:21-jdk
WORKDIR /app
COPY src ./src
RUN javac -d classes src/rpc/*.java
ENTRYPOINT ["java", "-cp", "classes"]
```

```yaml
# RPC 검증용 컨테이너 2개: server(구현 + 스켈레톤) <-> client(스텁)
services:
  server:
    build: .
    command: ["rpc.CalculatorServer"]

  client:
    build: .
    command: ["rpc.CalculatorClient", "server"] # "server" = 위 서비스 이름. compose 네트워크에서 호스트명(DNS)으로 쓰인다
    depends_on:
      - server # 컨테이너 시작 순서만 보장한다. 포트가 열릴 때까지 기다리는 일은 RpcClient.connect의 재시도가 맡는다
```

compose 네트워크에서는 서비스 이름이 곧 호스트명입니다. 그래서 클라이언트는 `server`라는 이름으로 서버 컨테이너에 접속합니다. 서버 포트는 `ports`로 호스트에 공개하지 않았는데, 이유는 마지막 절에서 다룹니다.

## 검증 1: 정상 호출과 예외 전파

`--exit-code-from client`를 주면 클라이언트가 끝날 때 compose도 함께 종료되고, 클라이언트의 종료 코드가 compose의 종료 코드가 됩니다.

```bash
docker compose up --build --exit-code-from client
echo $?    # 0
docker compose down
```

빌드 로그와 컨테이너 상태 출력을 빼면 다음과 같습니다.

```text
server-1  | [server] listening on 9090
server-1  | [server] add [2, 3] -> RpcResponse[result=5, error=null]
client-1  | [client] add(2, 3) -> 5  OK
server-1  | [server] divide [1, 0] -> RpcResponse[result=null, error=java.lang.ArithmeticException: / by zero]
client-1  | [client] divide(1, 0) -> java.lang.ArithmeticException: / by zero  OK
client-1 exited with code 0
```

계산은 `server-1`에서 일어났습니다. 같은 이미지라 클라이언트 컨테이너에도 `CalculatorServer.class`가 들어 있지만, `CalculatorClient`는 계약 인터페이스만 참조합니다. 서버에서 0으로 나누며 발생한 `ArithmeticException`은 직렬화되어 건너와 클라이언트의 `catch (ArithmeticException e)`에 그대로 잡혔습니다.

검증 환경은 Docker Engine 29.9.2, Docker Compose v5.6.1, `eclipse-temurin:21-jdk` 이미지입니다.

## 검증 2: 부분 실패

이번에는 서버가 응답하지 못하는 상황을 만듭니다. `docker compose pause`는 컨테이너의 프로세스를 얼립니다.

```bash
docker compose up -d server && sleep 2     # 서버가 포트를 열 시간을 준다
docker compose pause server                # 서버 프로세스를 얼린다
docker compose run --rm --no-deps client   # 5초 뒤 실패, 종료 코드 1
docker compose unpause server
docker compose logs server
docker compose down
```

클라이언트는 5초 뒤 타임아웃으로 실패했습니다. 스택 트레이스에서 중간 프레임을 줄이면 다음과 같습니다.

```text
Exception in thread "main" java.io.UncheckedIOException: RPC transport failure
    at rpc.RpcClient.call(RpcClient.java:39)
    at rpc.RpcClient.lambda$create$0(RpcClient.java:25)
    at jdk.proxy1/jdk.proxy1.$Proxy0.add(Unknown Source)
    at rpc.CalculatorClient.main(CalculatorClient.java:11)
Caused by: java.net.SocketTimeoutException: Read timed out
    ...
    at java.base/java.io.ObjectInputStream.<init>(ObjectInputStream.java:416)
    at rpc.RpcClient.call(RpcClient.java:36)
    ... 3 more
```

트레이스에서 두 가지를 읽을 수 있습니다. `$Proxy0.add`는 `calculator.add(2, 3)` 호출이 런타임에 생성된 프록시 클래스를 거쳤다는 흔적입니다. 타임아웃이 난 위치는 `ObjectInputStream` 생성자, 즉 응답 스트림의 헤더를 기다리던 지점입니다.

클라이언트는 연결을 맺고 로컬에서 요청 쓰기와 `flush()`를 마친 뒤 헤더를 기다리다 실패했습니다. 이것만으로 서버 애플리케이션이 요청을 받았거나 실행했는지는 알 수 없습니다. 서버 프로세스가 멈춰 있어도 운영체제 커널이 TCP 연결과 요청 바이트 수신을 처리할 수 있기 때문입니다.

`unpause` 직후의 서버 로그는 다음과 같습니다.

```text
server-1  | [server] listening on 9090
server-1  | [server] add [2, 3] -> RpcResponse[result=5, error=null]
```

재개 뒤 서버 로그에서 `add`가 실행된 사실을 확인했습니다. 클라이언트는 실패로 알고 종료했지만, 서버는 쌓여 있던 요청을 처리했습니다.

> **타임아웃이 알려 주는 것**
>
> 타임아웃은 호출이 실행되지 않았다는 뜻이 아닙니다. 응답을 받지 못했다는 사실만 알려 줍니다.

그래서 타임아웃 뒤에 무조건 재시도하면 같은 작업이 두 번 실행될 수 있습니다. 덧셈이라면 문제가 없지만 결제나 재고 차감이라면 사고가 됩니다. 실제 시스템은 같은 요청을 여러 번 실행해도 결과가 같도록 연산을 멱등(idempotent)하게 설계하거나, 요청에 식별자를 붙여 서버가 중복을 걸러내게 합니다. ONC RPC 명세(RFC 5531)의 `xid`도 서버가 재전송된 요청을 알아보는 데 쓰입니다.

Waldo 등은 "A Note on Distributed Computing"(1994)에서 원격 호출을 로컬 호출처럼 완전히 감출 수 없는 이유로 지연, 메모리 접근, 부분 실패, 동시성의 차이를 꼽았습니다. 검증 2는 그중 부분 실패를 재현한 셈입니다.

## 이 구현에서 뺀 것

최소 구성을 위해 실제 RPC 프레임워크가 갖춘 기능 상당수를 뺐습니다.

- 요청 ID와 다중화: 연결 하나에 여러 요청을 섞으려면 응답을 짝지을 번호가 필요합니다. 여기서는 호출마다 연결을 새로 열어 생략했습니다. gRPC는 HTTP/2 연결 하나에서 여러 호출을 동시에 처리합니다.
- 언어 중립 IDL과 코드 생성: Java 인터페이스는 Java끼리만 공유할 수 있습니다. 다른 언어와 호출을 주고받거나 스키마 버전을 관리하려면 `.proto` 같은 별도 정의가 필요합니다.
- 서비스 디스커버리, 로드 밸런싱, 인증
- 안전한 직렬화 형식: Java 직렬화는 신뢰할 수 없는 입력을 역직렬화하면 보안 취약점이 생깁니다. 그래서 compose에서 서버 포트를 호스트에 공개하지 않았습니다. 실제 시스템은 Protocol Buffers나 JSON처럼 데이터만 담는 형식을 씁니다.

## 참고 자료

- Andrew D. Birrell, Bruce Jay Nelson, [Implementing Remote Procedure Calls](https://doi.org/10.1145/2080.357392), ACM Transactions on Computer Systems 2(1), 1984
- Jim Waldo 외, [A Note on Distributed Computing](https://waldo.scholars.harvard.edu/publications/note-distributed-computing), Sun Microsystems Laboratories, 1994
- [RFC 5531: RPC: Remote Procedure Call Protocol Specification Version 2](https://www.rfc-editor.org/rfc/rfc5531)
- [Java 21 API: Proxy](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/reflect/Proxy.html)
- [Java 21 API: ObjectOutputStream](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/io/ObjectOutputStream.html)
- [Java 21 API: Socket](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/net/Socket.html)
- [JEP 444: Virtual Threads](https://openjdk.org/jeps/444)
- [Control startup and shutdown order in Compose](https://docs.docker.com/compose/how-tos/startup-order/)
