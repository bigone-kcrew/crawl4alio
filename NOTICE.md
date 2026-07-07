# 제3자 소프트웨어 고지 (Third-Party Notices)

crawl4alio(MIT, [LICENSE](LICENSE))는 아래 오픈소스 도구에 의존하거나 이를 연동합니다.
각 도구는 자체 라이선스를 따르며, 이 저장소는 해당 도구의 소스코드를 포함(벤더링)하지 않습니다.

| 도구 | 라이선스 | 연동 방식 |
|---|---|---|
| [kordoc](https://github.com/chrisryugj/kordoc) | MIT | `package.json` 런타임 의존성 — `collection/project/crawler/utils/parsers.js`에서 in-process로 직접 호출 |
| [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) | Apache-2.0 | 별도 서비스 — `deploy/paddleocr-parser/`에서 pip로 설치해 `/parse` API 래퍼로 감쌈(소스 벤더링 없음) |
| [Crawl4AI](https://github.com/unclecode/crawl4ai) | Apache-2.0 | 별도 서비스 — 공식 Docker 이미지(`unclecode/crawl4ai`)를 그대로 참조 |
| [MarkItDown](https://github.com/microsoft/markitdown) | MIT | 선택적 폴백 — 기본 의존성 아님, `MARKITDOWN_PARSE_URL` 설정 시에만 HTTP로 연동 |

각 라이선스 전문은 위 링크의 원 저장소를 참고하세요.
