export const calculateHoursUntilStart = (event, currentTime) => {
  if (event.scheduled_start_time) {
    const msUntilStart = event.scheduled_start_time.getTime() - currentTime.getTime();
    return Math.max(0, Math.round(msUntilStart / (60 * 60 * 1000)));
  }
  return 0;
};

export const calculateHoursRemaining = (event, currentTime) => {
  if (event.actual_end_time) {
    const msRemaining = event.actual_end_time.getTime() - currentTime.getTime();
    return Math.max(0, Math.round(msRemaining / (60 * 60 * 1000)));
  }
  
  const currentHour = currentTime.getHours();
  if (currentHour <= event.end_hour) {
    return event.end_hour - currentHour;
  }
  
  return 0;
};

export const getDateKey = (date) => {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

export const getSeason = (date) => {
  const month = date.getMonth();
  if (month >= 2 && month <= 4) return 'spring';
  if (month >= 5 && month <= 7) return 'summer';
  if (month >= 8 && month <= 10) return 'autumn';
  return 'winter';
};

export const getSeasonalTemp = (season) => {
  const temps = { spring: 10, summer: 18, autumn: 12, winter: 4 };
  return temps[season];
};