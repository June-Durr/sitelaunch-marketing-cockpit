import { Navigate, Route, BrowserRouter as Router, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { DataProvider } from './data/DataProvider';
import { AuthProvider } from './auth/AuthProvider';
import { AuthGate } from './auth/AuthGate';
import { Activity } from './screens/Activity';
import { ContentLog } from './screens/ContentLog';
import { DataImport } from './screens/DataImport';
import { Pipeline } from './screens/Pipeline';
import { Recommendations } from './screens/Recommendations';
import { Tasks } from './screens/Tasks';
import { Today } from './screens/Today';
import { WebsiteOutcomes } from './screens/WebsiteOutcomes';

export default function App() {
  return (
    <AuthProvider>
      <AuthGate>
        <DataProvider>
          <Router>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<Today />} />
            <Route path="content" element={<ContentLog />} />
            <Route path="website" element={<WebsiteOutcomes />} />
            <Route path="pipeline" element={<Pipeline />} />
            <Route path="tasks" element={<Tasks />} />
            <Route path="activity" element={<Activity />} />
            <Route path="recommendations" element={<Recommendations />} />
            <Route path="data" element={<DataImport />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
          </Router>
        </DataProvider>
      </AuthGate>
    </AuthProvider>
  );
}
