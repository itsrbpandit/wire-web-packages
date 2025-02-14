/*
 * Wire
 * Copyright (C) 2022 Wire Swiss GmbH
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see http://www.gnu.org/licenses/.
 *
 */

import {LowPrecisionTaskScheduler} from './LowPrecisionTaskScheduler';

describe('LowPrecisionTaskScheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(0));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("task won't run again after it was executed previously", async () => {
    const mockedTask = jest.fn(() => Promise.resolve('hello task'));

    LowPrecisionTaskScheduler.addTask({
      key: 'test-key',
      firingDate: 0,
      intervalDelay: 2000,
      task: mockedTask,
    });

    jest.advanceTimersByTime(2001);
    await Promise.resolve();

    jest.advanceTimersByTime(2001);
    await Promise.resolve();

    expect(mockedTask).toHaveBeenCalledTimes(1);
  });

  it('adds single task to schedule and runs it after given delay', async () => {
    const mockedTask = jest.fn(() => Promise.resolve('hello task'));

    LowPrecisionTaskScheduler.addTask({
      key: 'test-key',
      firingDate: 0,
      intervalDelay: 1000,
      task: mockedTask,
    });

    jest.advanceTimersByTime(1001);
    await Promise.resolve();

    expect(mockedTask).toHaveBeenCalled();
  });

  it('adds multiple tasks to schedule and runs it after given delay', async () => {
    const mockedTask1 = jest.fn().mockReturnValue(Promise.resolve('hello task 1'));
    const mockedTask2 = jest.fn().mockReturnValue(Promise.resolve('hello task 2'));

    LowPrecisionTaskScheduler.addTask({
      key: 'test1-key',
      firingDate: 0,
      intervalDelay: 5000,
      task: mockedTask1,
    });

    jest.advanceTimersByTime(1000);

    LowPrecisionTaskScheduler.addTask({
      key: 'test2-key',
      firingDate: 0,
      intervalDelay: 5000,
      task: mockedTask2,
    });

    jest.advanceTimersByTime(5001);

    await Promise.resolve();
    await Promise.resolve();

    expect(mockedTask1).toHaveBeenCalled();
    expect(mockedTask2).toHaveBeenCalled();
  });

  it('cancels tasks', async () => {
    const mockedTask3 = jest.fn().mockReturnValue(Promise.resolve('hello task 3'));
    const mockedTask4 = jest.fn().mockReturnValue(Promise.resolve('hello task 4'));

    LowPrecisionTaskScheduler.addTask({
      key: 'test3-key',
      firingDate: 0,
      intervalDelay: 4000,
      task: mockedTask3,
    });

    jest.advanceTimersByTime(1000);

    LowPrecisionTaskScheduler.addTask({
      key: 'test4-key',
      firingDate: 0,
      intervalDelay: 4000,
      task: mockedTask4,
    });

    LowPrecisionTaskScheduler.cancelTask({
      intervalDelay: 4000,
      key: 'test3-key',
    });

    jest.advanceTimersByTime(4001);

    await Promise.resolve();
    await Promise.resolve();

    expect(mockedTask3).not.toHaveBeenCalled();
    expect(mockedTask4).toHaveBeenCalled();
  });
});
