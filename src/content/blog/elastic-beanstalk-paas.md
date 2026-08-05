---
title: Elastic Beanstalk는 왜 PaaS로 분류되는가
date: 2026-07-20
tag: AWS
summary: 사용자가 인프라를 직접 제어하는가. 이 한 가지 기준으로 IaaS와 PaaS는 갈린다.
readingMinutes: 6
---

AWS 자격증 문제에서 반복해서 나오는 물음이 있다. "AWS에서 제공하는 PaaS 서비스는 무엇입니까?" 보기에는 S3, EC2, Lambda, Elastic Beanstalk가 나란히 놓인다. 답은 Elastic Beanstalk다.

## 제어권이 어디에 있는가

IaaS는 가상 머신, 스토리지, 네트워크를 사용자가 골라 조합한다. 그만큼 운영과 관리의 책임도 사용자에게 있다. PaaS는 그 층을 제공자가 가져간다. 서버 관리, 운영체제 업데이트, 보안 패치는 플랫폼의 몫이다.

```yaml
# .ebextensions/01-env.config
option_settings:
  aws:elasticbeanstalk:application:environment:
    NODE_ENV: production
```

위 설정 파일 하나로 환경 변수가 배포에 반영된다. 인스턴스에 접속해 셸을 열 일이 없다는 점, 그것이 분류의 근거다.

> **시험 포인트**
>
> Lambda는 서버리스(FaaS)로 따로 분류된다. PaaS를 묻는 문제에서 Lambda를 고르지 않도록 주의한다.
