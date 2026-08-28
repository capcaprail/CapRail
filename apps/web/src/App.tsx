import { NavLink, Outlet, Route, Routes } from 'react-router-dom'
import { Cabinet } from './screens/Cabinet.tsx'
import { Market } from './screens/Market.tsx'
import { Register } from './screens/Register.tsx'

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Register />} />
        <Route path="cabinet" element={<Cabinet />} />
        <Route path="market" element={<Market />} />
      </Route>
    </Routes>
  )
}

function Layout() {
  const item = ({ isActive }: { isActive: boolean }) => (isActive ? 'cur' : 'oth')
  return (
    <div className="page">
      <div className="proto">Prototype — mock data. Not connected to any network.</div>
      <nav className="nav">
        <NavLink to="/" end className={item}>
          Register
        </NavLink>
        <NavLink to="/cabinet" className={item}>
          Cabinet
        </NavLink>
        <NavLink to="/market" className={item}>
          Market
        </NavLink>
      </nav>
      <Outlet />
    </div>
  )
}
