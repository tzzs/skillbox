import { NavLink, Route, Routes } from 'react-router-dom'
import { Library, Bot, Settings, Compass, ArrowUpCircle } from 'lucide-react'
import { useHealth } from './queries.js'
import { AgentsPage } from './pages/AgentsPage.js'
import { CreateSkillPage } from './pages/CreateSkillPage.js'
import { DiffPage } from './pages/DiffPage.js'
import { ExplorePage } from './pages/ExplorePage.js'
import { LibraryPage } from './pages/LibraryPage.js'
import { SettingsPage } from './pages/SettingsPage.js'
import { SkillDetailPage } from './pages/SkillDetailPage.js'
import { SkillInstallPage } from './pages/SkillInstallPage.js'
import { UpdatesPage } from './pages/UpdatesPage.js'

const NAV_ITEMS = [
  { to: '/', label: 'Library', icon: Library, end: true },
  { to: '/explore', label: 'Explore', icon: Compass, end: false },
  { to: '/updates', label: 'Updates', icon: ArrowUpCircle, end: false },
  { to: '/agents', label: 'Agents', icon: Bot, end: false },
  { to: '/settings', label: 'Settings', icon: Settings, end: false },
]

/**
 * M11 — App Shell: persistent sidebar navigation (Library / Agents / Settings)
 * plus the routed pages. The health query feeds the little status pill so the
 * user always knows which repository the UI is talking to.
 */
export function App() {
  const health = useHealth()
  const repository = health.data?.repository

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">sb</span>
          <span className="brand-name">Skillbox</span>
        </div>

        <nav className="nav-list" aria-label="Main">
          {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => `nav-item${isActive ? ' nav-item--active' : ''}`}
            >
              <Icon aria-hidden="true" className="nav-icon" />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="health-row">
            <span className={`health-dot${health.isLoading ? ' health-dot--pending' : ''}`} />
            <span className="health-text">
              {health.isLoading
                ? 'Connecting…'
                : repository !== undefined
                  ? shortRepository(repository)
                  : 'Server offline'}
            </span>
          </div>
        </div>
      </aside>

      <main className="content">
        <Routes>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/explore" element={<ExplorePage />} />
          <Route path="/explore/install" element={<SkillInstallPage />} />
          <Route path="/updates" element={<UpdatesPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/skills/new" element={<CreateSkillPage />} />
          <Route path="/skills/:name" element={<SkillDetailPage />} />
          <Route path="/skills/:name/diff" element={<DiffPage />} />
        </Routes>
      </main>
    </div>
  )
}

function shortRepository(repository: string): string {
  const parts = repository.replace(/\\/g, '/').split('/').filter(Boolean)
  const tail = parts.slice(-2)
  return tail.length === 2 ? `${tail[0]}/${tail[1]}` : repository
}
