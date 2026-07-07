# OCR to Markdown

`PaddleOCR` 응답의 `result.markdown`을 `.md` 파일로 저장하는 CLI입니다.

다른 프로젝트에서 이 도구를 쓸 때는 아래 순서만 따르면 됩니다.

1. 이 README를 읽는다.
2. `ocrtomarkdown/ocr-to-markdown.js`를 실행한다.
3. `PaddleOCR`가 돌려준 Markdown을 원본 PDF 옆의 `.md` 파일로 저장한다.

## 실행

```bash
node ocrtomarkdown/ocr-to-markdown.js ./input.pdf
node ocrtomarkdown/ocr-to-markdown.js ./folder-of-pdfs
npm run ocr:markdown -- ./input.pdf
```

## 입력

- PDF 파일 1개
- PDF 파일이 들어 있는 디렉터리 1개

## 출력

- 기본 출력: 원본 PDF와 같은 폴더에 같은 이름의 `.md` 파일
- 디렉터리 입력 시 하위 PDF마다 같은 폴더에 `.md` 파일 생성
- `--output-dir`를 주면 별도 경로로 저장

## 동작

1. `PADDLEOCR_PARSE_URL` 또는 `PADDLEOCR_BASE_URL`을 읽는다.
2. PDF를 `POST /parse`로 보낸다.
3. 응답 JSON의 `result.markdown`을 꺼낸다.
4. YAML frontmatter를 붙여 `.md`로 저장한다.

## 환경 변수

- `PADDLEOCR_PARSE_URL`
- `PADDLEOCR_BASE_URL`

`PADDLEOCR_PARSE_URL`이 있으면 그 값을 우선 사용한다. 없으면 `PADDLEOCR_BASE_URL/parse`를 사용한다.

## frontmatter

기본 frontmatter 필드:

- `source_file`
- `source_path`
- `source_dir`
- `institution`
- `scd`
- `year`
- `ocr_service`
- `processed_at`
- `source_bytes`
- `source_ext`

`institution`, `scd`, `year`는 파일 경로에서 추론한다. 경로가 `.../structured_data/<institution>/<SCD>/<year>/...` 형태면 그 값을 그대로 넣는다. 그 외에는 가능한 범위에서 부모 디렉터리 이름을 사용한다.

## 큰 문서

- timeout은 파일 크기 기준으로 자동 계산한다.
- 실패 시 1회 재시도한다.
- 필요하면 `--timeout`으로 직접 지정한다.

## 옵션

```bash
node ocrtomarkdown/ocr-to-markdown.js --help
```

- `--output-dir <dir>`: 출력 디렉터리 지정
- `--timeout <ms>`: 요청 timeout 직접 지정
- `--retries <n>`: 재시도 횟수 지정
- `--no-frontmatter`: frontmatter 없이 저장
- `--base-url <url>`: `PaddleOCR` parse endpoint 직접 지정
