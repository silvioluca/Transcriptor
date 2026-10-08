// Configurazione Firebase (valori pubblici: la protezione dei dati è nelle regole di firestore.rules).
export const firebaseConfig = {
  apiKey: 'AIzaSyAsAWfS6qDdi-hb_Mw8ntt4BuMxqM4o-0M',
  authDomain: 'transcriptor-802d1.firebaseapp.com',
  projectId: 'transcriptor-802d1',
  storageBucket: 'transcriptor-802d1.firebasestorage.app',
  messagingSenderId: '621905706405',
  appId: '1:621905706405:web:8eff8525618ebf2e0dbc4c',
};

// Solo questi account possono usare l'archivio (deve coincidere con firestore.rules).
export const allowedEmails = ['silvio.phy@gmail.com'];
