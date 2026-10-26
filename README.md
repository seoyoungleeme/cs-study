# CS 면접 스터디

[fru1tworld/cs-basic](https://github.com/fru1tworld/cs-basic) 의 면접 질문 1,224개를
간격반복(SRS)으로 공부하는 정적 PWA. 아이폰 홈 화면에 추가해 앱처럼 씁니다.

- **질문**: 레포 `interview/` 의 19개 파일에서 파싱
- **모범답안**: 같은 레포 `docs/` 를 근거로 사전 생성
- **채점**: 내 답을 적으면 LLM(Gemini/OpenAI)이 모범답안과 대조해 점수·빠진 개념·꼬리질문을 돌려줌. API 키는 브라우저 localStorage 에만 저장되고 서버로 가지 않음
- **진도**: localStorage. 설정 탭에서 내보내기/가져오기

빌드 스크립트는 `build/` (이 저장소에는 결과물만 있음).
