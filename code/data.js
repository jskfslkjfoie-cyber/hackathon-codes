import { db, authReady } from "./firebase.js";
import {
  collection, collectionGroup, doc, addDoc, setDoc, getDoc, getDocs, updateDoc, deleteDoc,
  query, where, orderBy, onSnapshot, serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

/* ===================== 19대 고위험 질환 (PATIENT_DISEASE.disease_name) ===================== */
export const DISEASES = [
  { name: '전치태반', weight: 35, desc: '급성 대량출혈 위험' },
  { name: '태반조기박리', weight: 38, desc: '모체·태아 즉시 위험' },
  { name: '중증 자간전증', weight: 34, desc: '경련·장기손상 위험' },
  { name: '임신성 고혈압', weight: 18, desc: '자간전증 진행 위험' },
  { name: 'HELLP 증후군', weight: 36, desc: '간·혈액 응급' },
  { name: '조기진통', weight: 22, desc: '조산 위험' },
  { name: '양막 조기파열', weight: 20, desc: '감염·조산 위험' },
  { name: '다태임신', weight: 16, desc: '조산·출혈 위험 증가' },
  { name: '임신성 당뇨', weight: 12, desc: '거대아·분만합병증' },
  { name: '전치혈관', weight: 30, desc: '태아 출혈 위험' },
  { name: '자궁근종 합병', weight: 10, desc: '분만 진행 장애' },
  { name: '심장질환 동반', weight: 28, desc: '분만 중 심부전 위험' },
  { name: '신장질환 동반', weight: 22, desc: '전자간증·신부전' },
  { name: '갑상선 기능이상', weight: 8, desc: '대사 불안정' },
  { name: '정맥혈전색전증 과거', weight: 18, desc: '폐색전 위험' },
  { name: '산후출혈 과거력', weight: 14, desc: '재발 출혈 위험' },
  { name: '제왕절개 과거력', weight: 8, desc: '자궁파열·유착' },
  { name: '양수과소증', weight: 14, desc: '태아 곤란' },
  { name: '태아 성장지연', weight: 16, desc: '태아 곤란·조기분만' },
];

// 진단서 기준 중증도 3단계 (PATIENT_DISEASE.severity) — 가중치는 기능정의서에 수치가 없어 합리적 기본값으로 단계화
export const SEVERITY = [
  { code: 'GRADE_1', label: 'Grade I', mult: 1.0 },
  { code: 'GRADE_2', label: 'Grade II', mult: 1.3 },
  { code: 'GRADE_3', label: 'Grade III', mult: 1.6 },
];

// 현장 급성 증상 (EMS-002 체크리스트 + 증상일기 LLM 분류 키워드 공용)
export const ACUTE_SIGNALS = [
  { code: 'bleeding', label: '활동성 질출혈', weight: 30 },
  { code: 'membrane_rupture', label: '양수 파수', weight: 20 },
  { code: 'seizure', label: '경련 발작', weight: 40 },
  { code: 'severe_abdominal_pain', label: '극심한 하복부 통증', weight: 22 },
  { code: 'fetal_movement_decrease', label: '태동 급감/소실', weight: 24 },
  { code: 'headache_blurred_vision', label: '두통·시야흐림', weight: 24 },
  { code: 'dyspnea', label: '호흡곤란', weight: 26 },
  { code: 'fever', label: '고열', weight: 14 },
];

export const CONSCIOUSNESS_LEVELS = ['명료(Alert)', '기면(Verbal)', '혼미(Pain)', '혼수(Unresponsive)'];
export const REJECTION_REASONS = [
  { code: 'ROOM_SHORTAGE', label: '분만 수술실/격리분만실 포화' },
  { code: 'DOCTOR_ABSENCE', label: '산과 전문의 부재' },
  { code: 'NICU_SHORTAGE', label: 'NICU 인큐베이터 부족' },
  { code: 'OTHER_REASON', label: '기타' },
];

// 색상은 다크/라이트 배경 둘 다에서 텍스트로도 읽혔을 때 대비가 충분하도록 중간 채도로 고정한다
// (파스텔톤은 흰 배경에서 거의 안 보이고, 너무 짙으면 검은 배경에서 칙칙해지는 절충점).
export function grade(score) {
  if (score >= 70) return { key: 'EMERGENCY', label: '응급', cls: 'b-emer', color: '#e8384a' };
  if (score >= 45) return { key: 'HIGH', label: '고위험', cls: 'b-high', color: '#e07a2c' };
  if (score >= 22) return { key: 'MEDIUM', label: '중위험', cls: 'b-mid', color: '#c99a12' };
  return { key: 'LOW', label: '저위험', cls: 'b-low', color: '#2fb673' };
}

// 임신 주수: 분만예정일(EDD)은 통상 LMP+40주 기준이므로 실제 주수 = 40 - 잔여주수
export function gestationWeekFromEDD(eddStr) {
  const edd = new Date(eddStr);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const daysRemaining = Math.round((edd - today) / 86400000);
  const week = 40 - Math.ceil(daysRemaining / 7);
  return Math.max(0, Math.min(42, week));
}

// clinical_score = 질환 고유 가중치 x 중증도 가중치, 19대 질환 누적
export function calcClinicalScore(diseases) {
  let score = 0; const breakdown = [];
  (diseases || []).forEach(d => {
    const rule = DISEASES.find(x => x.name === d.disease_name);
    const sev = SEVERITY.find(x => x.code === d.severity) || SEVERITY[0];
    if (rule) {
      const w = Math.round(rule.weight * sev.mult);
      score += w;
      breakdown.push({ k: d.disease_name, w, t: `${rule.desc} · ${sev.label}` });
    }
  });
  return { clinical_score: Math.min(score, 100), breakdown };
}

export function infraScoreFromGrade(regionGrade) {
  // 시드 데이터셋은 HIGH_RISK/MEDIUM_RISK/LOW_RISK 표기를 쓰고, 기존 등록 흐름은
  // VULNERABLE/MODERATE/ADEQUATE를 쓴다 — 둘 다 동일 가중치 밴드로 매핑한다.
  return { VULNERABLE: 20, MODERATE: 10, ADEQUATE: 0, HIGH_RISK: 20, MEDIUM_RISK: 10, LOW_RISK: 0 }[regionGrade] ?? 0;
}

export function gestationWeight(week) {
  if (week < 28) return 14;
  if (week >= 37) return 6;
  return 0;
}

// LLM 분석 시뮬레이션: 증상일기 자연어 → detected_signals + pre_risk_level (실 LLM API 연동 전 키워드 휴리스틱)
export function classifySymptomDiary(text) {
  if (!text || !text.trim()) return { pre_risk_score: 0, detected_signals: [], llm_summary: '특이 신호 없음', hospital_visit_recommended: false };
  const map = {
    '출혈': 'bleeding', '피가': 'bleeding', '피를': 'bleeding', '하혈': 'bleeding',
    '양수': 'membrane_rupture', '파수': 'membrane_rupture',
    '경련': 'seizure', '쥐가': 'seizure',
    '복통': 'severe_abdominal_pain', '배가': 'severe_abdominal_pain', '아랫배': 'severe_abdominal_pain', '배뭉': 'severe_abdominal_pain', '뭉쳐': 'severe_abdominal_pain',
    '태동': 'fetal_movement_decrease', '안 움직': 'fetal_movement_decrease', '안움직': 'fetal_movement_decrease',
    '두통': 'headache_blurred_vision', '머리': 'headache_blurred_vision', '시야': 'headache_blurred_vision', '흐릿': 'headache_blurred_vision', '어지': 'headache_blurred_vision',
    '호흡': 'dyspnea', '숨이': 'dyspnea', '숨차': 'dyspnea',
    '열이': 'fever', '고열': 'fever',
  };
  let score = 0; const hits = new Set();
  for (const key in map) { if (text.includes(key)) hits.add(map[key]); }
  hits.forEach(code => { const s = ACUTE_SIGNALS.find(a => a.code === code); if (s) score += s.weight; });
  const detected_signals = [...hits];
  const labels = detected_signals.map(c => ACUTE_SIGNALS.find(a => a.code === c)?.label).filter(Boolean);
  return {
    pre_risk_score: Math.min(score, 100),
    detected_signals,
    llm_summary: labels.length ? `산모 서술에서 ${labels.join(', ')} 신호가 감지되었습니다.` : '특이 신호 없음',
    hospital_visit_recommended: score >= 22,
  };
}

/* ===================== 병원 추천 (HOSPITAL_RECOMMENDATION) ===================== */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 치료적합도 = NICU/산과 역량(중증일수록 가중) - 거리 페널티, 가까운 순/적합도순 정렬 후 상위 3
export function hospitalPriority(riskLevel, patientLoc, hospitals) {
  const severe = riskLevel === 'EMERGENCY' || riskLevel === 'HIGH';
  return hospitals.map(h => {
    const distance_km = Math.round(haversineKm(patientLoc.latitude, patientLoc.longitude, h.latitude, h.longitude) * 10) / 10;
    const eta_minutes = Math.max(3, Math.round(distance_km / 40 * 60));
    let fit = 50;
    fit += h.high_risk_delivery ? 20 : -40;
    fit += (h.nicu_available_beds || 0) * (severe ? 4 : 1.5);
    fit += h.is_obgyn_on_call ? 10 : -15;
    fit -= distance_km * 1.6;
    return { ...h, distance_km, eta_minutes, fit: Math.round(fit) };
  }).sort((a, b) => b.fit - a.fit).slice(0, 3).map((h, i) => ({ ...h, priority_rank: i + 1 }));
}

/* ===================== Firestore: PATIENT ===================== */
export async function createPatient(p) {
  await authReady;
  const ref = await addDoc(collection(db, 'patients'), {
    name: p.name, phone_number: p.phone_number,
    expected_delivery_date: p.expected_delivery_date,
    gestation_week: gestationWeekFromEDD(p.expected_delivery_date),
    multiple_pregnancy: !!p.multiple_pregnancy,
    created_at: serverTimestamp(),
  });
  return ref.id;
}

export async function getPatient(patientId) {
  await authReady;
  const snap = await getDoc(doc(db, 'patients', patientId));
  return snap.exists() ? { patient_id: snap.id, ...snap.data() } : null;
}

// 시트 날짜 문자열 → Firestore Timestamp (데모 시나리오의 고정 시각을 그대로 보존)
const ts = (s) => Timestamp.fromDate(new Date(s));

// 가상 시드 데이터셋(고맘워요_가상시드데이터)의 산모 4명 + 케이스 A/B/C/D.
// 위험도(risk)는 시트 9_RISK_ASSESSMENT를 그대로 저장하고 recomputeRisk를 호출하지 않는다.
// 단 clinical/infra_score만은 앱 UI가 grade(clinical+infra+gestation)로 배지를 계산하는
// 0~100 모델에 맞춰 sum이 시트 risk_level 밴드(HIGH 45~69 / MEDIUM 22~44)에 떨어지도록
// 스케일했다(시트의 1~3 tier 숫자를 그대로 쓰면 배지가 LOW로 잘못 표시되므로). 등급 자체는 일치.
const DEMO_PATIENTS = [
  {
    id: 'p1', name: '김지수', phone_number: '010-1234-5678', expected_delivery_date: '2026-09-15',
    gestation_week: 29, multiple_pregnancy: false, created_at: '2026-05-01',
    scenario: '케이스A — 전치태반/분만취약지/응급',
    location: { location_type: 'HOME', address: '경북 의성군 의성읍 의성로 100', region_code: '4720000000', region_grade: 'HIGH_RISK', latitude: 36.3525, longitude: 128.6970, stay_until: null },
    locations: [
      { location_id: 1, location_type: 'HOME', address: '경북 의성군 의성읍 의성로 100', region_code: '4720000000', region_grade: 'HIGH_RISK', latitude: 36.3525, longitude: 128.6970, stay_until: null },
    ],
    risk: { clinical_score: 40, infra_score: 8, gestation_weight: 0, risk_level: 'HIGH', pre_risk_score: 0, pre_risk_level: null, risk_track: 'CLINICAL', assessed_at: '2026-06-29T06:00:00' },
    diseases: [{ disease_name: '전치태반', severity: 'GRADE_3', diagnosed_at: '2026-05-10' }],
    vitals: [
      { systolic_bp: 118, diastolic_bp: 76, blood_glucose: 92, weight_kg: 72, height_cm: 163, bmi: 27.1, measured_at: '2026-06-15T09:00:00' },
      { systolic_bp: 125, diastolic_bp: 80, blood_glucose: 95, weight_kg: 73.5, height_cm: 163, bmi: 27.6, measured_at: '2026-06-22T10:00:00' },
      { systolic_bp: 138, diastolic_bp: 88, blood_glucose: 102, weight_kg: 75, height_cm: 163, bmi: 28.2, measured_at: '2026-06-28T08:30:00' },
      { systolic_bp: 155, diastolic_bp: 98, blood_glucose: 115, weight_kg: 76.5, height_cm: 163, bmi: 28.8, measured_at: '2026-06-29T06:00:00' },
    ],
    diary: [
      { diary_id: 4, content: '배가 살짝 당기는 느낌이에요', llm_summary: '복부 불편감. 전치태반 환자 — 출혈 여부 추가 확인 필요', detected_signals: '복부불편', pre_risk_level: 'MEDIUM', hospital_visit_recommended: true, visit_confirmed: true, created_at: '2026-06-26T20:00:00' },
    ],
    recommendations: [
      { hospital_id: 'h1', priority_rank: 1, distance_km: 42.3, eta_minutes: 38 },
      { hospital_id: 'h2', priority_rank: 2, distance_km: 98.7, eta_minutes: 82 },
      { hospital_id: 'h3', priority_rank: 3, distance_km: 85.2, eta_minutes: 70 },
    ],
  },
  {
    id: 'p2', name: '이미래', phone_number: '010-2345-6789', expected_delivery_date: '2026-10-20',
    gestation_week: 24, multiple_pregnancy: false, created_at: '2026-06-01',
    scenario: '케이스B — 임신중독증/지역이탈',
    location: { location_type: 'TEMPORARY', address: '대구광역시 수성구 달구벌대로 500', region_code: '2720010300', region_grade: 'MEDIUM_RISK', latitude: 35.8714, longitude: 128.6014, stay_until: '2026-07-10' },
    locations: [
      { location_id: 2, location_type: 'HOME', address: '서울특별시 강남구 테헤란로 200', region_code: '1168010800', region_grade: 'LOW_RISK', latitude: 37.5042, longitude: 127.0490, stay_until: null },
      { location_id: 3, location_type: 'TEMPORARY', address: '대구광역시 수성구 달구벌대로 500', region_code: '2720010300', region_grade: 'MEDIUM_RISK', latitude: 35.8714, longitude: 128.6014, stay_until: '2026-07-10' },
    ],
    risk: { clinical_score: 40, infra_score: 6, gestation_weight: 14, risk_level: 'HIGH', pre_risk_score: 0, pre_risk_level: null, risk_track: 'CLINICAL', assessed_at: '2026-06-29T07:00:00' },
    diseases: [
      { disease_name: '임신성 고혈압성 질환', severity: 'GRADE_3', diagnosed_at: '2026-06-05' },
      { disease_name: '임신중독증', severity: 'GRADE_3', diagnosed_at: '2026-06-10' },
    ],
    vitals: [
      { systolic_bp: 142, diastolic_bp: 92, blood_glucose: 98, weight_kg: 65, height_cm: 161, bmi: 25.1, measured_at: '2026-06-20T09:00:00' },
      { systolic_bp: 150, diastolic_bp: 96, blood_glucose: 105, weight_kg: 66, height_cm: 161, bmi: 25.5, measured_at: '2026-06-28T08:00:00' },
    ],
    diary: [
      { diary_id: 5, content: '머리가 자주 아파요. 대구 친정에 왔는데 좀 쉬고 있어요', llm_summary: '두통 반복. 임신성 고혈압 환자 — 즉각 주의 필요', detected_signals: '두통', pre_risk_level: 'HIGH', hospital_visit_recommended: true, visit_confirmed: false, created_at: '2026-06-27T19:00:00' },
    ],
    recommendations: [
      { hospital_id: 'h4', priority_rank: 1, distance_km: 3.2, eta_minutes: 8 },
      { hospital_id: 'h5', priority_rank: 2, distance_km: 4.1, eta_minutes: 10 },
      { hospital_id: 'h6', priority_rank: 3, distance_km: 7.8, eta_minutes: 18 },
    ],
  },
  {
    id: 'p3', name: '박소연', phone_number: '010-3456-7890', expected_delivery_date: '2026-08-30',
    gestation_week: 32, multiple_pregnancy: false, created_at: '2026-04-15',
    scenario: '케이스C — 증상일기/예비위험도',
    location: { location_type: 'HOME', address: '경기도 성남시 분당구 판교로 300', region_code: '4113510900', region_grade: 'LOW_RISK', latitude: 37.3943, longitude: 127.1109, stay_until: null },
    locations: [
      { location_id: 4, location_type: 'HOME', address: '경기도 성남시 분당구 판교로 300', region_code: '4113510900', region_grade: 'LOW_RISK', latitude: 37.3943, longitude: 127.1109, stay_until: null },
    ],
    risk: { clinical_score: 28, infra_score: 4, gestation_weight: 0, risk_level: 'MEDIUM', pre_risk_score: 75, pre_risk_level: 'HIGH', risk_track: 'PRELIMINARY', assessed_at: '2026-06-28T21:30:00' },
    diseases: [{ disease_name: '임신성 당뇨병 (인슐린 치료 안하는 경우)', severity: 'GRADE_2', diagnosed_at: '2026-04-20' }],
    vitals: [
      { systolic_bp: 110, diastolic_bp: 70, blood_glucose: 145, weight_kg: 68.5, height_cm: 158, bmi: 27.5, measured_at: '2026-06-25T09:00:00' },
      { systolic_bp: 115, diastolic_bp: 73, blood_glucose: 155, weight_kg: 69, height_cm: 158, bmi: 27.7, measured_at: '2026-06-28T09:00:00' },
    ],
    diary: [
      { diary_id: 1, content: '요즘 소변이 자주 마렵고 약간 피곤해요', llm_summary: '일상적 임신 증상 범위. 특이 신호 없음', detected_signals: '없음', pre_risk_level: 'LOW', hospital_visit_recommended: false, visit_confirmed: false, created_at: '2026-06-20T21:00:00' },
      { diary_id: 2, content: '두통이 좀 있고 발이 약간 부은 것 같아요', llm_summary: '두통+부종 감지. 임신중독증 초기 신호 가능성', detected_signals: '두통,부종', pre_risk_level: 'MEDIUM', hospital_visit_recommended: true, visit_confirmed: false, created_at: '2026-06-25T22:00:00' },
      { diary_id: 3, content: '두통이 심해지고 눈이 침침해요. 발도 많이 부었어요', llm_summary: '두통+시야장애+부종 복합 감지. 임신중독증 고위험 신호', detected_signals: '두통,시야장애,부종', pre_risk_level: 'HIGH', hospital_visit_recommended: true, visit_confirmed: true, created_at: '2026-06-28T21:30:00' },
    ],
    recommendations: [
      { hospital_id: 'h7', priority_rank: 1, distance_km: 2.1, eta_minutes: 6 },
      { hospital_id: 'h8', priority_rank: 2, distance_km: 0.8, eta_minutes: 3 },
    ],
  },
  {
    id: 'p4', name: '최은지', phone_number: '010-4567-8901', expected_delivery_date: '2026-11-10',
    gestation_week: 20, multiple_pregnancy: true, created_at: '2026-06-15',
    scenario: '추가 케이스 — 쌍둥이/고령',
    location: { location_type: 'HOME', address: '부산광역시 해운대구 센텀중앙로 400', region_code: '2635010100', region_grade: 'LOW_RISK', latitude: 35.1731, longitude: 129.1325, stay_until: null },
    locations: [
      { location_id: 5, location_type: 'HOME', address: '부산광역시 해운대구 센텀중앙로 400', region_code: '2635010100', region_grade: 'LOW_RISK', latitude: 35.1731, longitude: 129.1325, stay_until: null },
    ],
    risk: { clinical_score: 24, infra_score: 4, gestation_weight: 14, risk_level: 'MEDIUM', pre_risk_score: 0, pre_risk_level: null, risk_track: 'CLINICAL', assessed_at: '2026-06-29T10:00:00' },
    diseases: [
      { disease_name: '다태임신', severity: 'GRADE_2', diagnosed_at: '2026-06-20' },
      { disease_name: '고혈압', severity: 'GRADE_2', diagnosed_at: '2026-06-20' },
    ],
    vitals: [
      { systolic_bp: 120, diastolic_bp: 78, blood_glucose: 90, weight_kg: 78, height_cm: 160, bmi: 30.5, measured_at: '2026-06-28T10:00:00' },
    ],
    diary: [],
    recommendations: [
      { hospital_id: 'h9', priority_rank: 1, distance_km: 5.4, eta_minutes: 12 },
      { hospital_id: 'h10', priority_rank: 2, distance_km: 8.9, eta_minutes: 20 },
    ],
  },
];

// 데모 산모 시드 (등록 흐름 시연 없이도 보건소/119 화면을 바로 확인할 수 있도록).
// createPatient를 우회하고 setDoc으로 직접 생성한다 — gestation_week·created_at·risk를 시트 값 그대로
// 보존해야 하므로(EDD 기반 자동 계산/serverTimestamp/재계산을 쓰지 않는다). 서브컬렉션도 결정적
// ID(d0/v0/e0…)로 써서 재실행(동시 로드)해도 중복이 생기지 않게 한다.
async function writePatients() {
  const hospName = (id) => DEMO_HOSPITALS.find(h => h.id === id)?.hospital_name || '';
  const hospBeds = (id) => DEMO_HOSPITALS.find(h => h.id === id)?.nicu_available_beds ?? 0;
  for (const p of DEMO_PATIENTS) {
    await setDoc(doc(db, 'patients', p.id), {
      name: p.name, phone_number: p.phone_number, expected_delivery_date: p.expected_delivery_date,
      gestation_week: p.gestation_week, multiple_pregnancy: p.multiple_pregnancy, scenario: p.scenario,
      created_at: ts(p.created_at),
      location: p.location,
      risk: { ...p.risk, assessed_at: ts(p.risk.assessed_at) },
      hospital_recommendation: p.recommendations.map(r => ({
        hospital_id: r.hospital_id, hospital_name: hospName(r.hospital_id), priority_rank: r.priority_rank,
        distance_km: r.distance_km, eta_minutes: r.eta_minutes, nicu_available_beds: hospBeds(r.hospital_id),
      })),
    });
    await Promise.all(p.diseases.map((d, i) => setDoc(doc(db, 'patients', p.id, 'diseases', `d${i}`), { disease_name: d.disease_name, severity: d.severity, diagnosed_at: ts(d.diagnosed_at) })));
    await Promise.all(p.vitals.map((v, i) => setDoc(doc(db, 'patients', p.id, 'vitals', `v${i}`), {
      systolic_bp: v.systolic_bp, diastolic_bp: v.diastolic_bp, blood_glucose: v.blood_glucose,
      blood_sugar: v.blood_glucose, weight_kg: v.weight_kg, height_cm: v.height_cm, bmi: v.bmi, measured_at: ts(v.measured_at),
    })));
    // diary_id는 문서 ID(e1~e5)로만 인코딩해 시트 순서를 보존하고, 저장 필드에는 넣지 않는다
    // (listDiaries가 diary_id에 문서 ID를 채우므로 필드로 두면 충돌해 방문확인 동작이 깨진다).
    await Promise.all(p.diary.map(({ diary_id, ...rest }) => setDoc(doc(db, 'patients', p.id, 'diary', `e${diary_id}`), { ...rest, created_at: ts(rest.created_at) })));
    // 체류지 이력(이동형 프로필) — 시트 3_LOCATION 전체를 보존. patient.location(현재값)은 별도로 둔다.
    await Promise.all((p.locations || []).map(l => setDoc(doc(db, 'patients', p.id, 'locations', `loc${l.location_id}`), { ...l, stay_until: l.stay_until || null })));
  }
}

// 케이스 A/B 응급신고 + 병원 수용 릴레이 로그 시드 (10_EMERGENCY). 119 콘솔이 비어 있어도
// 시나리오를 바로 시연할 수 있도록 생성한다.
async function writeEmergencies() {
  const recsFor = async (patientId) => {
    const pd = await getDoc(doc(db, 'patients', patientId));
    return pd.exists() ? (pd.data().hospital_recommendation || []) : [];
  };
  // req1 — 케이스A(김지수): 안동병원(1순위) NICU 만실로 거절 → 경북대(2순위) 수용 확정
  const p1 = await getPatient('p1');
  await setDoc(doc(db, 'emergencyRequests', 'er1'), {
    patient_id: 'p1', current_risk_level: 'HIGH', request_status: 'ACCEPTED',
    profile_snapshot: { name: p1?.name, gestation_week: p1?.gestation_week, risk: p1?.risk },
    recommendations: await recsFor('p1'), current_rank: 2, accepted_hospital_id: 'h2', created_at: ts('2026-06-29T06:05:00'),
  });
  await setDoc(doc(db, 'emergencyRequests', 'er1', 'responses', 'r1'), { hospital_id: 'h1', response_type: 'REJECT', priority_rank: 1, rejection_reason: 'NICU_SHORTAGE', responded_at: ts('2026-06-29T06:06:00') });
  await setDoc(doc(db, 'emergencyRequests', 'er1', 'responses', 'r2'), { hospital_id: 'h2', response_type: 'ACCEPT', priority_rank: 2, rejection_reason: null, responded_at: ts('2026-06-29T06:08:00') });
  // req2 — 케이스B(이미래): 대구 체류 중 응급 → 영남대(1순위) 즉시 수용
  const p2 = await getPatient('p2');
  await setDoc(doc(db, 'emergencyRequests', 'er2'), {
    patient_id: 'p2', current_risk_level: 'HIGH', request_status: 'ACCEPTED',
    profile_snapshot: { name: p2?.name, gestation_week: p2?.gestation_week, risk: p2?.risk },
    recommendations: await recsFor('p2'), current_rank: 1, accepted_hospital_id: 'h4', created_at: ts('2026-06-29T07:05:00'),
  });
  await setDoc(doc(db, 'emergencyRequests', 'er2', 'responses', 'r1'), { hospital_id: 'h4', response_type: 'ACCEPT', priority_rank: 1, rejection_reason: null, responded_at: ts('2026-06-29T07:06:00') });
}

// 컬렉션 내 모든 문서(+지정 서브컬렉션)를 삭제. Firestore 클라이언트는 서브컬렉션을 자동
// 삭제하지 않으므로 명시적으로 비운다.
async function clearAllDocs(collName, subcols = []) {
  const snap = await getDocs(collection(db, collName));
  for (const d of snap.docs) {
    for (const sub of subcols) {
      const subSnap = await getDocs(collection(db, collName, d.id, sub));
      await Promise.all(subSnap.docs.map(s => deleteDoc(s.ref)));
    }
    await deleteDoc(d.ref);
  }
}

// 버전 마커 기반 시드. 마커 버전이 최신(SEED_VERSION)이면 아무것도 안 하고, 구버전/최초이면
// 기존 데모 데이터(구 시드 포함)를 모두 지운 뒤 최신 시나리오 데이터로 덮어쓴다. 결정적 문서
// ID를 쓰므로 동시 로드로 두 번 실행돼도 최종 상태는 동일하다(중복 없음).
export async function ensureSeedData() {
  await authReady;
  const markerRef = doc(db, 'hospitals', SEED_MARKER_ID);
  const marker = await getDoc(markerRef);
  if (marker.exists() && (marker.data().version || 0) >= SEED_VERSION) return;
  await clearAllDocs('emergencyRequests', ['responses', 'assessment']);
  await clearAllDocs('patients', ['diseases', 'vitals', 'diary', 'notes', 'locations']);
  await clearAllDocs('hospitals');
  await writeHospitals();
  await writePatients();
  await writeEmergencies();
  await setDoc(markerRef, { version: SEED_VERSION, applied_at: serverTimestamp() });
}

export async function listPatients() {
  await authReady;
  const snap = await getDocs(collection(db, 'patients'));
  return snap.docs.map(d => ({ patient_id: d.id, ...d.data() }));
}

export function watchPatients(cb) {
  authReady.then(() => onSnapshot(collection(db, 'patients'), snap => {
    cb(snap.docs.map(d => ({ patient_id: d.id, ...d.data() })));
  }));
}

/* ---- PATIENT_DISEASE ---- */
export async function addDisease(patientId, disease_name, severity) {
  await authReady;
  await addDoc(collection(db, 'patients', patientId, 'diseases'), { disease_name, severity });
  return recomputeRisk(patientId);
}
export async function listDiseases(patientId) {
  await authReady;
  const snap = await getDocs(collection(db, 'patients', patientId, 'diseases'));
  return snap.docs.map(d => ({ disease_id: d.id, ...d.data() }));
}

// 체류지 이력(3_LOCATION) — 데모 가이드에서 시트 원본을 보여주기 위한 조회.
export async function listLocations(patientId) {
  await authReady;
  const snap = await getDocs(collection(db, 'patients', patientId, 'locations'));
  return snap.docs.map(d => ({ location_doc_id: d.id, ...d.data() }));
}

/* ---- VITAL_SIGN ---- */
export async function addVital(patientId, v) {
  await authReady;
  await addDoc(collection(db, 'patients', patientId, 'vitals'), {
    systolic_bp: v.systolic_bp ?? null, diastolic_bp: v.diastolic_bp ?? null,
    blood_sugar: v.blood_sugar ?? null, measured_at: serverTimestamp(),
  });
  if (v.systolic_bp > 140 || v.diastolic_bp > 90) await recomputeRisk(patientId, { forceHigh: true });
}
export async function listVitals(patientId) {
  await authReady;
  const snap = await getDocs(query(collection(db, 'patients', patientId, 'vitals'), orderBy('measured_at', 'desc')));
  return snap.docs.map(d => ({ vital_id: d.id, ...d.data() }));
}

/* ---- LOCATION (단일 현재값 + 이력 둘 다 필요해 patient 문서 필드로 관리) ---- */
export async function updateLocation(patientId, loc) {
  await authReady;
  const stay_until = loc.location_type === 'TEMPORARY' && !loc.stay_until
    ? new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
    : loc.stay_until || null;
  await updateDoc(doc(db, 'patients', patientId), {
    location: {
      location_type: loc.location_type, address: loc.address || null,
      latitude: loc.latitude, longitude: loc.longitude,
      region_grade: loc.region_grade || 'ADEQUATE', stay_until,
    },
  });
}

/* ---- PUBLIC_HEALTH_NOTE ---- */
export async function addHealthNote(patientId, note_content, created_by) {
  await authReady;
  await addDoc(collection(db, 'patients', patientId, 'notes'), { note_content, created_by, created_at: serverTimestamp() });
}
export async function listHealthNotes(patientId) {
  await authReady;
  const snap = await getDocs(query(collection(db, 'patients', patientId, 'notes'), orderBy('created_at', 'desc')));
  return snap.docs.map(d => ({ note_id: d.id, ...d.data() }));
}

/* ---- SYMPTOM_DIARY ---- */
export async function addSymptomDiary(patientId, content) {
  await authReady;
  const result = classifySymptomDiary(content);
  const pre_risk_level = grade(result.pre_risk_score).key;
  const ref = await addDoc(collection(db, 'patients', patientId, 'diary'), {
    content, llm_summary: result.llm_summary, detected_signals: result.detected_signals.join(','),
    pre_risk_level, hospital_visit_recommended: result.hospital_visit_recommended,
    visit_confirmed: false, created_at: serverTimestamp(),
  });
  await recomputeRisk(patientId, { pre_risk_score: result.pre_risk_score, pre_risk_level, diary_id: ref.id });
  return { diary_id: ref.id, pre_risk_level, ...result };
}
export async function listDiaries(patientId) {
  await authReady;
  const snap = await getDocs(query(collection(db, 'patients', patientId, 'diary'), orderBy('created_at', 'desc')));
  return snap.docs.map(d => ({ diary_id: d.id, ...d.data() }));
}
export async function confirmDiaryVisit(patientId, diaryId) {
  await authReady;
  await updateDoc(doc(db, 'patients', patientId, 'diary', diaryId), { visit_confirmed: true });
}

// DASH-003: 병원방문 권고 후 미방문 산모 추적 (collection-group 쿼리, 전 산모 diary 서브컬렉션 횡단)
export function watchUnconfirmedDiaries(cb) {
  authReady.then(() => onSnapshot(
    query(collectionGroup(db, 'diary'), where('hospital_visit_recommended', '==', true), where('visit_confirmed', '==', false)),
    snap => cb(snap.docs.map(d => ({ diary_id: d.id, patient_id: d.ref.parent.parent.id, ...d.data() })))
  ));
}

/* ---- RISK_ASSESSMENT (patient 문서에 최신 스냅샷 저장) ---- */
export async function recomputeRisk(patientId, opts = {}) {
  const [patient, diseases] = await Promise.all([getPatient(patientId), listDiseases(patientId)]);
  const { clinical_score } = calcClinicalScore(diseases);
  const infra_score = infraScoreFromGrade(patient?.location?.region_grade);
  const gestation_weight = gestationWeight(patient?.gestation_week || 0);
  let total = clinical_score + infra_score + gestation_weight;
  if (opts.forceHigh) total = Math.max(total, 45);
  const risk_level = grade(total).key;
  const risk = {
    clinical_score, infra_score, gestation_weight, risk_level,
    pre_risk_score: opts.pre_risk_score ?? patient?.risk?.pre_risk_score ?? 0,
    pre_risk_level: opts.pre_risk_level ?? patient?.risk?.pre_risk_level ?? null,
    diary_id: opts.diary_id ?? patient?.risk?.diary_id ?? null,
    assessed_at: Timestamp.now(),
  };
  await updateDoc(doc(db, 'patients', patientId), { risk });
  return risk;
}

/* ===================== Firestore: HOSPITAL ===================== */
// 시드 데이터 버전. 이 값을 올리면 다음 로드 때 기존(구버전) 데이터를 지우고 새로 덮어쓴다.
// 버전 마커는 보안규칙이 허용하는 hospitals 컬렉션 안에 보관하고(별도 meta 컬렉션은 규칙
// 미허용) 목록/구독에서는 필터링한다.
const SEED_VERSION = 5;
const SEED_MARKER_ID = '__seed__';

// 가상 시드 데이터셋(고맘워요_가상시드데이터: 6_HOSPITAL + 7_HOSPITAL_STATUS 병합).
// 결정적 문서 ID(h1~h10)를 써서 추천/응급 릴레이 로그가 hospital_id로 교차 참조할 수 있게 한다.
// 상태 행이 없는 h8·h10은 합리적 기본값(NICU 2병상, 당직의 재실)을 채우고 status 메타는 생략한다.
// status_id/status_updated_at/scenario_note는 7_HOSPITAL_STATUS를 병원 문서에 직접 보관한 값
// (hospitals 하위 서브컬렉션은 보안규칙 미허용이라 문서 필드로 둔다).
const DEMO_HOSPITALS = [
  { id: 'h1', hospital_name: '안동병원', region_code: '4713000000', high_risk_delivery: true, nicu_available: true, emergency_phone: '054-840-1000', latitude: 36.5720, longitude: 128.7320, is_regional_center: true, nicu_available_beds: 0, is_obgyn_on_call: false, status_id: 1, status_updated_at: '2026-06-29T06:10:00', scenario_note: '1순위 병원 — NICU 만실 + 당직의 부재 → 거절' },
  { id: 'h2', hospital_name: '경북대학교병원', region_code: '4711000000', high_risk_delivery: true, nicu_available: true, emergency_phone: '053-200-5114', latitude: 35.8685, longitude: 128.6060, is_regional_center: true, nicu_available_beds: 3, is_obgyn_on_call: true, status_id: 2, status_updated_at: '2026-06-29T06:10:00', scenario_note: '2순위 병원 — 수용 가능 → 수용 확정' },
  { id: 'h3', hospital_name: '칠곡경북대학교병원', region_code: '4719000000', high_risk_delivery: true, nicu_available: true, emergency_phone: '053-200-2114', latitude: 35.9845, longitude: 128.4780, is_regional_center: false, nicu_available_beds: 1, is_obgyn_on_call: true, status_id: 3, status_updated_at: '2026-06-29T06:10:00', scenario_note: '3순위 병원 — 대기' },
  { id: 'h4', hospital_name: '영남대학교병원', region_code: '2711000000', high_risk_delivery: true, nicu_available: true, emergency_phone: '053-620-3114', latitude: 35.8600, longitude: 128.6220, is_regional_center: true, nicu_available_beds: 2, is_obgyn_on_call: true, status_id: 4, status_updated_at: '2026-06-29T07:00:00', scenario_note: '케이스B 1순위 — 수용 가능' },
  { id: 'h5', hospital_name: '대구가톨릭대학교병원', region_code: '2711000000', high_risk_delivery: true, nicu_available: true, emergency_phone: '053-650-4114', latitude: 35.8714, longitude: 128.6070, is_regional_center: false, nicu_available_beds: 0, is_obgyn_on_call: true, status_id: 5, status_updated_at: '2026-06-29T07:00:00', scenario_note: '케이스B 2순위 — NICU 만실' },
  { id: 'h6', hospital_name: '계명대학교동산병원', region_code: '2711000000', high_risk_delivery: true, nicu_available: false, emergency_phone: '053-250-7114', latitude: 35.8580, longitude: 128.4980, is_regional_center: false, nicu_available_beds: 1, is_obgyn_on_call: false, status_id: 6, status_updated_at: '2026-06-29T07:00:00', scenario_note: '케이스B 3순위 — 당직의 부재' },
  { id: 'h7', hospital_name: '분당서울대학교병원', region_code: '4113000000', high_risk_delivery: true, nicu_available: true, emergency_phone: '031-787-7114', latitude: 37.3490, longitude: 127.1230, is_regional_center: true, nicu_available_beds: 4, is_obgyn_on_call: true, status_id: 7, status_updated_at: '2026-06-29T09:00:00', scenario_note: '케이스C 1순위 — 수용 가능' },
  { id: 'h8', hospital_name: '차의과학대학교 분당차병원', region_code: '4113000000', high_risk_delivery: true, nicu_available: true, emergency_phone: '031-780-5000', latitude: 37.3940, longitude: 127.1110, is_regional_center: false, nicu_available_beds: 2, is_obgyn_on_call: true },
  { id: 'h9', hospital_name: '부산대학교병원', region_code: '2611000000', high_risk_delivery: true, nicu_available: true, emergency_phone: '051-240-7114', latitude: 35.1760, longitude: 129.0630, is_regional_center: true, nicu_available_beds: 3, is_obgyn_on_call: true, status_id: 8, status_updated_at: '2026-06-29T10:00:00', scenario_note: '케이스D 1순위 — 수용 가능' },
  { id: 'h10', hospital_name: '고신대학교복음병원', region_code: '2611000000', high_risk_delivery: true, nicu_available: true, emergency_phone: '051-990-6114', latitude: 35.1040, longitude: 128.9990, is_regional_center: false, nicu_available_beds: 2, is_obgyn_on_call: true },
];
async function writeHospitals() {
  await Promise.all(DEMO_HOSPITALS.map(({ id, status_updated_at, ...h }) =>
    setDoc(doc(db, 'hospitals', id), status_updated_at ? { ...h, status_updated_at: ts(status_updated_at) } : h)));
}

export async function listHospitals() {
  await authReady;
  const snap = await getDocs(collection(db, 'hospitals'));
  return snap.docs.filter(d => d.id !== SEED_MARKER_ID).map(d => ({ hospital_id: d.id, ...d.data() }));
}
export function watchHospitals(cb) {
  authReady.then(() => onSnapshot(collection(db, 'hospitals'), snap => {
    cb(snap.docs.filter(d => d.id !== SEED_MARKER_ID).map(d => ({ hospital_id: d.id, ...d.data() })));
  }));
}
// 좌표 → 주소 역지오코딩 (Nominatim/OpenStreetMap, API 키 불필요). 결과는 hospital 문서에 캐싱해
// 최초 1회만 호출되도록 하고, 동시 호출을 직렬화해 정책상 호출 빈도(1req/s)를 지킨다.
let geocodeQueue = Promise.resolve();
function reverseGeocode(lat, lng) {
  geocodeQueue = geocodeQueue.then(() => new Promise(resolve => setTimeout(resolve, 1100)));
  return geocodeQueue.then(() =>
    fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=jsonv2&accept-language=ko&addressdetails=1`)
      .then(r => r.json())
      .then(d => {
        // display_name 의 선두에 붙는 POI/건물명(예: "나루아트센터 소공연장")이나 동 이름이
        // 섞이면 네이버 지도 도로명주소 검색이 매칭하지 못한다. 시/도 + 구 + 도로명 + 건물번호
        // (표준 도로명주소 형식, 동 이름 제외)로만 재조립한다.
        const a = d.address || {};
        const district = a.borough || a.city_district || a.county || '';
        const parts = [a.city || a.state, district, a.road, a.house_number].filter(Boolean);
        return parts.length ? parts.join(' ') : (d.display_name || null);
      })
      .catch(() => null)
  );
}
// 주소 형식이 바뀔 때마다 올려서, 구버전 클라이언트가 캐싱한(형식이 다른) 주소를 다음 조회
// 시 무조건 재생성하도록 한다. 단순 존재 여부만 보면 옛 캐시값을 영구히 신뢰하게 되어버린다.
const ADDRESS_FORMAT_VERSION = 2;
export async function ensureHospitalAddress(hospital) {
  if (hospital.address && hospital.address_v === ADDRESS_FORMAT_VERSION) return hospital.address;
  await authReady;
  const address = await reverseGeocode(hospital.latitude, hospital.longitude);
  if (address) await updateDoc(doc(db, 'hospitals', hospital.hospital_id), { address, address_v: ADDRESS_FORMAT_VERSION });
  return address;
}

export async function updateHospitalStatus(hospitalId, status) {
  await authReady;
  await updateDoc(doc(db, 'hospitals', hospitalId), {
    nicu_available_beds: status.nicu_available_beds, is_obgyn_on_call: status.is_obgyn_on_call,
  });
}

export async function saveRecommendations(patientId, recs) {
  await authReady;
  await updateDoc(doc(db, 'patients', patientId), {
    hospital_recommendation: recs.map(r => ({
      hospital_id: r.hospital_id, hospital_name: r.hospital_name, priority_rank: r.priority_rank,
      distance_km: r.distance_km, eta_minutes: r.eta_minutes, nicu_available_beds: r.nicu_available_beds,
    })),
  });
}

/* ===================== Firestore: EMERGENCY_REQUEST / EMS_ASSESSMENT / HOSPITAL_RESPONSE ===================== */
export async function createEmergencyRequest(patientId, profileSnapshot, recommendations) {
  await authReady;
  const ref = await addDoc(collection(db, 'emergencyRequests'), {
    patient_id: patientId, current_risk_level: profileSnapshot.risk?.risk_level || 'LOW',
    request_status: 'PENDING', profile_snapshot: profileSnapshot,
    recommendations, current_rank: 1, created_at: serverTimestamp(),
  });
  return ref.id;
}
export async function addEmsAssessment(requestId, flags) {
  await authReady;
  await addDoc(collection(db, 'emergencyRequests', requestId, 'assessment'), { ...flags, recorded_at: serverTimestamp() });
  const snap = await getDoc(doc(db, 'emergencyRequests', requestId));
  const data = snap.data();
  await updateDoc(doc(db, 'emergencyRequests', requestId), {
    profile_snapshot: { ...data.profile_snapshot, ems_assessment: flags },
  });
}
export function watchEmergencyRequests(cb) {
  authReady.then(() => onSnapshot(collection(db, 'emergencyRequests'), snap => {
    cb(snap.docs.map(d => ({ request_id: d.id, ...d.data() })));
  }));
}
export function watchEmergencyRequest(requestId, cb) {
  authReady.then(() => onSnapshot(doc(db, 'emergencyRequests', requestId), snap => {
    if (snap.exists()) cb({ request_id: snap.id, ...snap.data() });
  }));
}
export async function respondToRequest(requestId, hospitalId, response_type, priority_rank, reject_reason) {
  await authReady;
  await addDoc(collection(db, 'emergencyRequests', requestId, 'responses'), {
    hospital_id: hospitalId, response_type, priority_rank, rejection_reason: reject_reason || null,
    responded_at: serverTimestamp(),
  });
  if (response_type === 'ACCEPT') {
    await updateDoc(doc(db, 'emergencyRequests', requestId), { request_status: 'ACCEPTED', accepted_hospital_id: hospitalId });
  } else {
    const snap = await getDoc(doc(db, 'emergencyRequests', requestId));
    const data = snap.data();
    const nextRank = (data.current_rank || 1) + 1;
    if (nextRank > (data.recommendations || []).length) {
      await updateDoc(doc(db, 'emergencyRequests', requestId), { request_status: 'NO_HOSPITAL_AVAILABLE' });
    } else {
      await updateDoc(doc(db, 'emergencyRequests', requestId), { current_rank: nextRank });
    }
  }
}
export function watchResponses(requestId, cb) {
  authReady.then(() => onSnapshot(query(collection(db, 'emergencyRequests', requestId, 'responses'), orderBy('responded_at', 'asc')), snap => {
    cb(snap.docs.map(d => ({ response_id: d.id, ...d.data() })));
  }));
}
