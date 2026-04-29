# trua launch dashboard

trua 세제 브랜드 런칭을 3인 팀이 함께 따라가기 위한 가벼운 정적 대시보드.
빌드 스텝 없이 GitHub Pages만으로 운영한다.

## 라이브 주소 (Pages 활성화 후)
`https://ameliepgy314.github.io/triview/`

## 한 화면 요약
- **대시보드** — 전체 진척도, D-day, 단계별 진척, 마감 임박 태스크, 최근 회의/아이디어
- **런칭 단계** — 13개 단계 × 태스크 단위 체크리스트 (담당자/상태/마감 필터)
- **담당** — 멤버별 진행중 태스크 모아보기
- **회의록** — 마크다운으로 작성, 사이드에서 클릭하면 본문 렌더링
- **아이데이션** — 카테고리 카드 보드 (브랜드/제품/마케팅/패키지/채널 등)
- **가이드** — 코드 모르는 사람도 깃허브 웹에서 편집하는 법

## 디렉토리
```
index.html
assets/
  style.css
  app.js
data/
  config.json        # 런칭일, 브랜드명
  team.json          # 멤버 (id/name/role/color)
  stages.json        # 13개 단계 + 태스크
  meetings.json      # 회의록 인덱스
  ideas.json         # 아이데이션 카드
  meetings/
    2026-04-29-kickoff.md
```

## 어떻게 업데이트하나

### 태스크 진척도
`data/stages.json` 의 task에서 `status`를 다음 중 하나로 바꿔 저장:
- `todo` 대기 / `doing` 진행중 / `done` 완료 / `blocked` 막힘

`owner`(team.json의 id)와 `due`(YYYY-MM-DD)도 같은 파일에서 수정.

### 회의록 추가
1. `data/meetings/2026-05-06-주간회의.md` 생성
2. `data/meetings.json` 의 배열 맨 앞에 항목 추가

### 아이디어 추가
`data/ideas.json` 의 `ideas` 배열에 항목 push. 카테고리는 자유.

### 멤버 변경
`data/team.json` 에서 이름/역할/색 수정. `id`는 stages·ideas의 owner 키이므로 변경 시 같이 업데이트.

### 런칭일
`data/config.json` 의 `launchDate` 수정 → 대시보드 D-day가 자동 갱신.

## GitHub Pages 배포
1. 리포 → **Settings → Pages**
2. Source: **Deploy from a branch**
3. Branch: **main / (root)** 선택 → Save
4. 1~2분 후 안내된 URL에서 접속

## 로컬 미리보기
```sh
python3 -m http.server 8000
# http://localhost:8000
```
(JSON fetch 때문에 `file://` 직접 열기는 동작 안 함)

## 비밀번호/인증
없음. 리포가 public이면 누구나 볼 수 있음.
민감 정보(원가, 협력사 단가 등)는 별도 비공개 노트로 관리하고 여기엔 두지 말 것.
