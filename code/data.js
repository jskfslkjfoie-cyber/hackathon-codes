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

export function grade(score) {
  if (score >= 70) return { key: 'EMERGENCY', label: '응급', cls: 'b-emer', color: '#ff6b6b' };
  if (score >= 45) return { key: 'HIGH', label: '고위험', cls: 'b-high', color: '#ff9b6b' };
  if (score >= 22) return { key: 'MEDIUM', label: '중위험', cls: 'b-mid', color: '#ffcf5c' };
  return { key: 'LOW', label: '저위험', cls: 'b-low', color: '#54d98c' };
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
  return { VULNERABLE: 20, MODERATE: 10, ADEQUATE: 0 }[regionGrade] ?? 0;
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

// 최초 1회 부트스트랩: 데모 산모 시드 (등록 흐름 시연 없이도 보건소/119 화면을 바로 확인할 수 있도록)
export async function seedPatientsIfEmpty() {
  await authReady;
  const snap = await getDocs(collection(db, 'patients'));
  if (!snap.empty) return;
  const demo = [
    { name: '산모 A', phone_number: '010-1234-5601', weeksFromNow: 6, diseases: [['전치태반', 'GRADE_3'], ['임신성 고혈압', 'GRADE_2']], loc: { latitude: 37.5060, longitude: 126.9570 } },
    { name: '산모 B', phone_number: '010-1234-5602', weeksFromNow: 10, diseases: [['임신성 당뇨', 'GRADE_1']], loc: { latitude: 37.5640, longitude: 127.0020 } },
    { name: '산모 C', phone_number: '010-1234-5603', weeksFromNow: 14, diseases: [['다태임신', 'GRADE_2'], ['조기진통', 'GRADE_2']], loc: { latitude: 37.4980, longitude: 126.9300 } },
  ];
  for (const d of demo) {
    const edd = new Date(Date.now() + d.weeksFromNow * 7 * 86400000).toISOString().slice(0, 10);
    const id = await createPatient({ name: d.name, phone_number: d.phone_number, expected_delivery_date: edd, multiple_pregnancy: false });
    for (const [name, sev] of d.diseases) await addDisease(id, name, sev);
    await updateLocation(id, { location_type: 'HOME', latitude: d.loc.latitude, longitude: d.loc.longitude, region_grade: 'ADEQUATE' });
  }
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
const DEMO_HOSPITALS = [
  { hospital_name: '중앙대학교병원', high_risk_delivery: true, nicu_available: true, nicu_available_beds: 6, is_obgyn_on_call: true, latitude: 37.5060, longitude: 126.9570, emergency_phone: '0000000000' },
  { hospital_name: '권역 모자센터', high_risk_delivery: true, nicu_available: true, nicu_available_beds: 9, is_obgyn_on_call: true, latitude: 37.5640, longitude: 127.0020, emergency_phone: '0000000000' },
  { hospital_name: '성모여성병원', high_risk_delivery: true, nicu_available: true, nicu_available_beds: 3, is_obgyn_on_call: true, latitude: 37.4980, longitude: 126.9300, emergency_phone: '0000000000' },
  { hospital_name: '시립의료원', high_risk_delivery: true, nicu_available: false, nicu_available_beds: 0, is_obgyn_on_call: true, latitude: 37.5380, longitude: 127.0700, emergency_phone: '0000000000' },
  { hospital_name: '북부권역응급센터', high_risk_delivery: true, nicu_available: true, nicu_available_beds: 5, is_obgyn_on_call: false, latitude: 37.6500, longitude: 127.0260, emergency_phone: '0000000000' },
];
// 최초 1회 부트스트랩: hospitals 컬렉션이 비어 있으면 데모 병원 시드 — 별도 관리자 권한 없이 일반 클라이언트 권한으로 동작
export async function seedHospitalsIfEmpty() {
  await authReady;
  const snap = await getDocs(collection(db, 'hospitals'));
  if (!snap.empty) return;
  await Promise.all(DEMO_HOSPITALS.map(h => addDoc(collection(db, 'hospitals'), h)));
}

export async function listHospitals() {
  await authReady;
  const snap = await getDocs(collection(db, 'hospitals'));
  return snap.docs.map(d => ({ hospital_id: d.id, ...d.data() }));
}
export function watchHospitals(cb) {
  authReady.then(() => onSnapshot(collection(db, 'hospitals'), snap => {
    cb(snap.docs.map(d => ({ hospital_id: d.id, ...d.data() })));
  }));
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
