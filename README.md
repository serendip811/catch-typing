# Catch Typing MVP

실시간으로 같은 단어를 먼저 정확히 입력해 획득하는 멀티플레이 타이핑 아케이드 프로토타입입니다.

## 실행

Node.js 20 이상이 필요합니다.

```bash
npm install
npm --prefix server install
npm --prefix client install
npm run dev
```

- 게임 화면: <http://localhost:5173>
- 실시간 서버: `ws://localhost:8080`

브라우저 창을 두 개 열고, 첫 창에서 방을 만든 뒤 표시된 코드를 두 번째 창에 입력하면 멀티플레이를 확인할 수 있습니다. 첫 창의 방장이 게임을 시작합니다.

서버 없이 화면과 기본 입력을 확인하려면 첫 화면의 **혼자 연습해 보기**를 선택합니다.

## 검증

```bash
npm run check
```

이 명령은 서버 타입 검사, 클라이언트 프로덕션 빌드, 게임 판정 테스트를 순서대로 실행합니다.

## 현재 구현 범위

- 닉네임과 방 코드 기반 2~4인 플레이
- 서버 권위의 동일 단어 선착순 판정
- 60초 단어 쟁탈전과 목표 자동 보충
- 성공, 오타, 한발 늦음 피드백
- 점수와 콤보
- 3콤보마다 블러/먹물 자동 방해
- 픽셀 오락실풍 반응형 화면
- 방해 효과 감소 옵션과 로컬 연습 모드

상세 설계는 [게임 기획서](outputs/Catch-Typing-Game-Design-Document.md)를 참고하세요.

## 공개 배포 구조

- GitHub Pages는 `client/`를 빌드해 정적 게임 화면을 배포합니다.
- 실시간 대전은 `server/`의 WebSocket 서버가 별도로 필요합니다.
- 루트의 `render.yaml`은 Render Web Service 배포 설정입니다.

서버 배포 후 GitHub 저장소의 **Settings → Secrets and variables → Actions → Variables**에 다음 값을 등록하고 Pages 워크플로를 다시 실행합니다.

```text
VITE_WS_URL=wss://배포된-서버-주소
```

이 값이 없더라도 GitHub Pages의 **혼자 연습해 보기**는 사용할 수 있습니다.
