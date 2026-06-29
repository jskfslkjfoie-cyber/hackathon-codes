import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import { getAnalytics, isSupported as analyticsSupported } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-analytics.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyAxWIciEwr7cNjMMne9IhCojNISihTnOYU",
  authDomain: "momsafe.firebaseapp.com",
  projectId: "momsafe",
  storageBucket: "momsafe.firebasestorage.app",
  messagingSenderId: "683132181928",
  appId: "1:683132181928:web:28c1072a1c3d469e16519d",
  measurementId: "G-N5KJVTRFGL"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

analyticsSupported().then((ok) => { if (ok) getAnalytics(app); });

export const authReady = new Promise((resolve) => {
  const unsub = onAuthStateChanged(auth, (user) => {
    if (user) { unsub(); resolve(user); }
    else { signInAnonymously(auth).catch((err) => console.error("anon auth failed", err)); }
  });
});
